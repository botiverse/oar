import { UnsupportedOptionError } from "../contracts/errors.js";
import { constants } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runExecutable } from "./executable/run.js";
import { privateTempDir, sweepPrivateTempDirs, type PrivateTempDir } from "./private-temp.js";

/*
 * One-shot private handoff for a runtime `--mcp-config <path>` file whose
 * `env` and `headers` values carry credentials.
 *
 * On POSIX the path is a 0600 FIFO inside a fresh 0700 directory from
 * privateTempDir, so the payload never reaches disk. OAR polls O_WRONLY |
 * O_NONBLOCK until the child opens the read end (ENXIO until then, keeping
 * libuv worker threads free), writes the document, closes, and removes the
 * directory immediately. Where FIFOs are unavailable (Windows, or no `mkfifo`),
 * the path is a 0600 file removed when `end()` is called (after initialization
 * or on process exit).
 */

/** How an MCP config reaches one child process: `path`, `start()` once spawned, `releaseAfterRead()` after startup handshake (file fallback only; FIFO removes itself after feeding), and `end()` on exit or launch failure (idempotent). */
export interface McpConfigHandoff {
  readonly path: string;
  start(): void;
  releaseAfterRead(): void;
  end(): void;
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
      // A failed feed (child closed its end early) leaves the runtime to report
      // the config it could not read; the directory goes either way.
      void (async (): Promise<void> => {
        try {
          await feed();
        } catch {
          // The runtime's own error is the report.
        } finally {
          end();
        }
      })();
    },
    releaseAfterRead: () => {
      // A FIFO removes itself once the child finishes reading; never cut an active feed early.
    },
    end,
  };
}

/** Remove directories dead hosts left behind, releasing any child still waiting on an abandoned FIFO. */
export async function sweepAbandonedMcpConfigDirs(prefix: string): Promise<void> {
  await sweepPrivateTempDirs(prefix);
}

/** Create a private FIFO (or 0600 file fallback) carrying `content` under `prefix`. */
export async function handOverMcpConfigFile(prefix: string, content: string, fileRefusal?: string): Promise<McpConfigHandoff> {
  const directory = await privateTempDir(prefix);
  const file = path.join(directory.path, "mcp.json");
  try {
    if (await makeFifo(file)) {
      return fifoHandoff(file, content, directory);
    }
    if (fileRefusal !== undefined) { throw new UnsupportedOptionError("mcpServers", fileRefusal); }
    await writeFile(file, content, { mode: 0o600, flag: "wx" });
  } catch (error) {
    directory.remove();
    throw error;
  }
  const remove = (): void => {
    directory.remove();
  };
  return {
    path: file,
    start: () => {
      // Non-FIFO platforms read the 0600 file; callers remove it via releaseAfterRead() or end().
    },
    releaseAfterRead: remove,
    end: remove,
  };
}
