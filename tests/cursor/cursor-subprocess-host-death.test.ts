import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { killedHost } from "../fixtures/cursor-killed-host.js";
import { alive, reportedPids, tempDirectory, until } from "../fixtures/cursor-subprocess.js";

/*
 * A host SIGKILLed while a subprocess-mode cursor session is open runs no
 * exit hook, so only the child itself can end: its IPC channel disconnects,
 * and it ends its own tree. Real processes: the host is a fresh node opening
 * a session over the fake SDK module, whose run starts a grandchild (a tool
 * the agent runs) before the host kills itself: one that leads a process
 * group of its own, as SDK 1.3.1's shell tool does on POSIX, and one in the
 * child's group.
 */

/*
 * `deaf-spawn` removes the child's disconnect listeners first: the child then
 * notices its host is gone only by its parent pid changing (a check every
 * second), as one whose event loop was too busy to see the disconnect would.
 */
test.each([
  ["spawn", "inherit"], ["spawn-in-group", "inherit"], ["deaf-spawn", "inherit"],
  ["spawn", "clean"], ["deaf-spawn", "clean"],
] as const)(
  // oxlint-disable-next-line eslint/max-statements -- the killed host, both pids, the agent's close, and the cleanup of a failed run, together.
  "a SIGKILLed host's cursor child closes its agent and stops with what it started (%s, %s)", async (how, envBase) => {
  const dir = tempDirectory();
  const file = path.join(dir, "pids.json");
  const host = killedHost(dir, file, { how, envBase });
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
