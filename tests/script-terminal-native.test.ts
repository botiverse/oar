import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { findScriptUtility, openScriptTerminal } from "../packages/oar/src/shared/executable/script-terminal.js";

/*
 * The real `script` utility and a synthetic program, no Claude: a program
 * that starts a child ignoring HUP and TERM and exits before any output
 * (Otter's probe on #752). The child is reparented away from `script`, so
 * only what the terminal kept while running can find it.
 */

async function startTicks(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

// oxlint-disable-next-line eslint/max-statements -- One probe: start, wait for the exit, kill, check, and always clean up its own child.
test.skipIf(process.platform !== "linux" || findScriptUtility() === null)("a child left behind by a program that exited first is ended by kill", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oar-script-terminal-"));
  const program = path.join(dir, "program.sh");
  const pidFile = path.join(dir, "child.pid");
  let pid: number | undefined = undefined;
  let started: string | undefined = undefined;
  try {
    await writeFile(program, `#!/bin/sh\nsh -c 'trap "" HUP TERM; echo $$ > "$CHILD_PID"; exec sleep 60' </dev/null >/dev/null 2>&1 &\nsleep 0.2\nexit 0\n`, { mode: 0o700 });
    const terminal = openScriptTerminal({ command: program, cwd: dir, env: { PATH: "/usr/bin:/bin", CHILD_PID: pidFile }, cols: 120, rows: 45, platform: "linux" });
    expect(terminal).not.toBeNull();
    terminal?.onData(() => {});
    // oxlint-disable-next-line promise/avoid-new -- The terminal reports its exit by callback.
    await new Promise<void>((resolve) => { terminal?.onExit(resolve); });
    const written = await readFile(pidFile, "utf8");
    pid = Number(written.trim());
    started = await startTicks(pid);
    expect(started).toBeDefined();
    await terminal?.kill();
    expect(await startTicks(pid)).toBeUndefined();
  } finally {
    // Never leave the probe's own child behind, and never signal a reused pid.
    if (pid !== undefined && started !== undefined && await startTicks(pid) === started) { process.kill(pid, "SIGKILL"); }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
