import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { alive, FAKE_SDK_MODULE, reportedPids, tempDirectory, until } from "../fixtures/cursor-subprocess.js";

/*
 * A host SIGKILLed while a subprocess-mode cursor session is open runs no
 * exit hook, so only the child itself can end: its IPC channel disconnects,
 * and it ends its own tree. Real processes: the host is a fresh node opening
 * a session over the fake SDK module, whose run starts a grandchild (a tool
 * the agent runs) before the host kills itself: one that leads a process
 * group of its own, as SDK 1.3.1's shell tool does on POSIX, and one in the
 * child's group.
 */

const source = path.join(import.meta.dirname, "../../packages/oar/src");

/** A host that opens a session, has its run start a tool (`how`) that writes the pids to `file`, and SIGKILLs itself. */
function killedHost(dir: string, file: string, how: string): SpawnSyncReturns<string> {
  const script = `import { createCursorRuntime } from ${JSON.stringify(pathToFileURL(path.join(source, "index.ts")).href)};
import { awaitTurnEnd } from ${JSON.stringify(pathToFileURL(path.join(source, "observe/turns.ts")).href)};
const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: ${JSON.stringify(FAKE_SDK_MODULE)} });
const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: ${JSON.stringify(dir)}, env: { OAR_FAKE_CURSOR_CLOSED: ${JSON.stringify(path.join(dir, "closed"))} } });
const prompt = await session.prompt(${JSON.stringify(`${how}:${file}`)});
await awaitTurnEnd(session, prompt.seq);
process.kill(process.pid, "SIGKILL");`;
  // A short grace, so the child's own waits end well within the test.
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OAR_KILL_GRACE_MS: "2000" } });
}

// oxlint-disable-next-line eslint/max-statements -- the killed host, both pids, the agent's close, and the cleanup of a failed run, together.
test.each(["spawn", "spawn-in-group"])("a SIGKILLed host's cursor child closes its agent and stops with what it started (%s)", async (how) => {
  const dir = tempDirectory();
  const file = path.join(dir, "pids.json");
  const host = killedHost(dir, file, how);
  const { child, grandchild } = reportedPids(file);
  try {
    // Windows terminates the process outright (exit 1); the session was open either way, or stderr says why not.
    expect(process.platform === "win32" ? { status: host.status, stderr: host.stderr } : { signal: host.signal, stderr: host.stderr })
      .toEqual(process.platform === "win32" ? { status: 1, stderr: "" } : { signal: "SIGKILL", stderr: "" });
    await until(() => !alive(child) && !alive(grandchild), 10_000);
    expect({ child: alive(child), grandchild: alive(grandchild) }, "the cursor child or its tool outlived the killed host").toEqual({ child: false, grandchild: false });
    // The child closed its agent (the SDK's own close work) before it ended.
    expect(existsSync(path.join(dir, "closed"))).toBe(true);
  } finally {
    for (const pid of [child, grandchild]) {
      if (alive(pid)) { process.kill(pid, "SIGKILL"); }
    }
  }
});
