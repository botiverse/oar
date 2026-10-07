import { spawn, spawnSync } from "node:child_process";
import { constants, readdirSync } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "../../../packages/oar/src/contracts/session.js";
import { claudeMcpConfig } from "../../../packages/oar/src/runtimes/claude/mcp-config.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";

/*
 * The claude `--mcp-config` FIFO handoff (runtimes/claude/mcp-config.ts) seen
 * from a vendor test: the directories this process's sessions hold, and a
 * claude whose FIFO writer comes late.
 */

/** The `--mcp-config` directories this process's claude sessions hold now. */
export function claudeConfigDirectories(): readonly string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`oar-claude-mcp-${String(process.pid)}-`));
}

/** Those directories once none is left, or as they are after `ms`. */
export async function claudeConfigsGone(ms: number): Promise<readonly string[]> {
  const deadline = Date.now() + ms;
  while (claudeConfigDirectories().length > 0 && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling for claude's startup read.
    await delay(50);
  }
  return claudeConfigDirectories();
}

/** The write end of `fifo` once a reader waits on it: a non-blocking open fails with ENXIO before. */
async function writerOnceRead(fifo: string, ms: number): Promise<FileHandle> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling, as mcp-config.ts does.
      return await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (Date.now() > deadline || !(error instanceof Error && "code" in error && error.code === "ENXIO")) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- as above.
    await delay(20);
  }
}

/**
 * claude (`command`, `env` on top of this process's) given `--mcp-config` on
 * a FIFO whose writer opens only once claude waits on it and writes the
 * servers' document a second later still. After `prompt`, what claude's
 * `system/init` lists as `mcp_servers`, or why there was none.
 */
export async function lateWriterServers(command: string, env: Readonly<Record<string, string>>, servers: readonly McpServer[], prompt: string): Promise<unknown> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-test-late-writer-"));
  try {
    const fifo = path.join(directory, "mcp.json");
    if (spawnSync("mkfifo", ["-m", "600", fifo]).status !== 0) {
      throw new Error("mkfifo failed");
    }
    const claude = spawn(command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--mcp-config", fifo], {
      cwd: directory,
      env: { ...process.env, CLAUDECODE: undefined, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const init = Promise.withResolvers<unknown>();
    const exited = Promise.withResolvers<void>();
    claude.once("exit", () => {
      init.resolve("claude exited before system/init");
      exited.resolve();
    });
    createInterface({ input: claude.stdout }).on("line", (line) => {
      const frame = asRecord(JSON.parse(line));
      if (frame?.type === "system" && frame.subtype === "init") {
        init.resolve(frame.mcp_servers);
      }
    });
    const writer = await writerOnceRead(fifo, 30_000);
    await delay(1000);
    await writer.write(JSON.stringify(claudeMcpConfig(servers)));
    await writer.close();
    claude.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    const listed = await init.promise;
    claude.stdin.end();
    await exited.promise;
    return listed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
