import { constants } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "../../contracts/session.js";
import { runExecutable } from "../../shared/executable/run.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";
import { privateTempDir, sweepPrivateTempDirs, type PrivateTempDir } from "../../shared/private-temp.js";

/*
 * SessionOptions.mcpServers reach claude as `--mcp-config <path>`: a path,
 * never inline JSON on argv, which every user on the machine can read
 * (`ps`), because `env` and `headers` values are credentials.
 *
 * On POSIX the path is a FIFO (mode 0600, in a fresh 0700 directory from
 * privateTempDir), so the values never reach a disk. oar opens the write end
 * without blocking once claude has opened the read end (ENXIO until then;
 * polled, so no libuv thread waits on it), writes the document, closes, and
 * removes the directory at once. claude 2.1.292 opens the path once at
 * startup, waits for the writer when it gets there first, and keeps the
 * config in memory: a stdio server it restarts and an http server it
 * initializes again after a 404 both get their credentials with the path
 * gone. sea-trial/vendor/claude-mcp-config.vendor.test.ts checks this on every
 * claude CI installs; if it fails, this handoff needs a new design, never a
 * session that silently loses its servers. Where FIFOs are unavailable
 * (Windows, or no `mkfifo` to run) the path is a 0600 file, removed when
 * claude exits.
 *
 * A host that ends without disposing leaves the directory to privateTempDir's
 * backstops, and every claude launch sweeps (`sweepAbandonedMcpConfigs`). A
 * host killed by a signal in claude's startup window leaves a claude blocked
 * opening the FIFO; the sweep releases it (an empty document: claude reports
 * an invalid config and exits).
 */

/** How the config reaches one claude process: the `--mcp-config` path, `start()` once claude is spawned, `end()` once it has exited or failed to spawn (idempotent). */
export interface McpConfigHandoff {
  readonly path: string;
  start(): void;
  end(): void;
}

/** claude's `--mcp-config` document for the entries: stdio `{type, command, args, env}`, http `{type, url, headers}`. */
export function claudeMcpConfig(servers: readonly McpServer[]): { readonly mcpServers: Record<string, unknown> } {
  return {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
      ? { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
      : { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }) }])),
  };
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** A 0600 FIFO at `file`; false where none can be made. */
async function makeFifo(file: string): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }
  const made = await runExecutable("mkfifo", ["-m", "600", file]);
  return made.ok;
}

/** The write end once a reader has the FIFO open; undefined when `stopped()` first. */
async function openWhenRead(file: string, stopped: () => boolean): Promise<FileHandle | undefined> {
  let wait = 5;
  while (!stopped()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling: each attempt waits for the previous one.
      return await open(file, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) !== "ENXIO") {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- as above; unref'd, so polling alone keeps no host alive.
    await delay(wait, undefined, { ref: false });
    wait = Math.min(wait * 2, 100);
  }
  return undefined;
}

/** Write all of `content` to a non-blocking pipe: a full pipe answers EAGAIN until the reader drains it. */
async function writeAll(handle: FileHandle, content: Buffer, stopped: () => boolean): Promise<void> {
  let rest = content;
  while (rest.length > 0 && !stopped()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential writes to one pipe.
      const { bytesWritten } = await handle.write(rest);
      rest = rest.subarray(bytesWritten);
    } catch (error) {
      if (errorCode(error) !== "EAGAIN") {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await delay(5, undefined, { ref: false });
    }
  }
}

function fifoHandoff(file: string, content: string, directory: PrivateTempDir): McpConfigHandoff {
  let ended = false;
  const stopped = (): boolean => ended;
  const end = (): void => {
    ended = true;
    directory.remove();
  };
  const feed = async (): Promise<void> => {
    const handle = await openWhenRead(file, stopped);
    if (handle === undefined) {
      return;
    }
    try {
      await writeAll(handle, Buffer.from(content), stopped);
    } finally {
      await handle.close();
    }
  };
  return {
    path: file,
    start: () => {
      // A failed feed (claude closed its end early) leaves claude to report
      // the config it could not read; the directory goes either way.
      void (async (): Promise<void> => {
        try {
          await feed();
        } catch {
          // claude's own error is the report.
        } finally {
          end();
        }
      })();
    },
    end,
  };
}

const PREFIX = "oar-claude-mcp-";

/**
 * Before any claude starts, with servers or without: remove what hosts that
 * died left behind, letting a claude still waiting on such a FIFO go.
 */
export async function sweepAbandonedMcpConfigs(): Promise<void> {
  await sweepPrivateTempDirs(PREFIX);
}

/** The handoff for these entries (sweeping as above first). Rejects on an empty or repeated name before anything is created. */
export async function handOverMcpConfig(servers: readonly McpServer[]): Promise<McpConfigHandoff> {
  checkMcpServerNames(servers);
  const directory = await privateTempDir(PREFIX);
  const file = path.join(directory.path, "mcp.json");
  const content = JSON.stringify(claudeMcpConfig(servers));
  try {
    if (await makeFifo(file)) {
      return fifoHandoff(file, content, directory);
    }
    await writeFile(file, content, { mode: 0o600, flag: "wx" });
  } catch (error) {
    directory.remove();
    throw error;
  }
  return {
    path: file,
    start: () => {
      // claude reads the file at startup; it goes when claude exits (end).
    },
    end: () => {
      directory.remove();
    },
  };
}
