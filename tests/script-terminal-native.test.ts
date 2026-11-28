import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { findScriptUtility, openScriptTerminal } from "../packages/oar/src/shared/executable/script-terminal.js";
import { processStart } from "./fixtures/process-tree.js";

/*
 * The real `script` utility and a synthetic program, no Claude: a program
 * that starts a child ignoring HUP and TERM and exits before any output
 * (Otter's probe on #752). The child is reparented away from the program
 * before the terminal has looked at anything; the shell under `script` ends
 * the program's session when the program exits.
 */

async function startTicks(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // A zombie has ended; only its parent has not collected it yet.
    return fields[0] === "Z" ? undefined : fields[19];
  } catch {
    return undefined;
  }
}

// oxlint-disable-next-line eslint/max-statements -- One probe: start, wait for the exit, kill, check, and always clean up its own child.
test.skipIf(process.platform !== "linux" || findScriptUtility() === null)("a child left behind by a program that exited first is ended with its session", async () => {
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
    // The shell ended the program's session as soon as the program exited, before any kill.
    expect(started).toBeUndefined();
    await terminal?.kill();
    expect(await startTicks(pid)).toBeUndefined();
  } finally {
    // Never leave the probe's own child behind, and never signal a reused pid.
    if (pid !== undefined && started !== undefined && await startTicks(pid) === started) { process.kill(pid, "SIGKILL"); }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function waitForExit(terminal: NonNullable<ReturnType<typeof openScriptTerminal>>, ms: number): Promise<boolean> {
  const exited = Promise.withResolvers<boolean>();
  terminal.onExit(() => { exited.resolve(true); });
  const timer = setTimeout(() => { exited.resolve(false); }, ms);
  try {
    return await exited.promise;
  } finally {
    clearTimeout(timer);
  }
}

// oxlint-disable-next-line eslint/max-statements -- Live PID reuse reproduction using a real POSIX script session and /proc stat.
test.skipIf(process.platform !== "linux" || findScriptUtility() === null)("watchdog stops when live hostPid has a different start time (PID reuse) and stays alive when it matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oar-script-reuse-"));
  const program = path.join(dir, "program.sh");
  await writeFile(program, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
  const replacement = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  expect(replacement.pid).toBeDefined();
  const replacementPid = replacement.pid ?? 0;
  const replacementStart = processStart(replacementPid);
  expect(replacementStart).toBeDefined();
  const baseHost = {
    findScript: findScriptUtility,
    spawn,
    listProcesses: () => [{ pid: replacementPid, parentPid: 1, startedAt: replacementStart ?? "" }],
    signal: (targetPid: number, sig: NodeJS.Signals) => { process.kill(targetPid, sig); },
    hostPid: replacementPid,
  };
  const liveTerminal = openScriptTerminal({ command: program, cwd: dir, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24, platform: "linux" }, baseHost);
  const reusedTerminal = openScriptTerminal({ command: program, cwd: dir, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24, platform: "linux" }, {
    ...baseHost,
    listProcesses: () => [{ pid: replacementPid, parentPid: 1, startedAt: `${replacementStart ?? "1"}999` }],
  });
  try {
    expect(liveTerminal).not.toBeNull();
    expect(reusedTerminal).not.toBeNull();
    if (liveTerminal === null || reusedTerminal === null) { return; }
    liveTerminal.onData(() => {});
    reusedTerminal.onData(() => {});
    expect(await waitForExit(reusedTerminal, 6000)).toBe(true);
    expect(await waitForExit(liveTerminal, 1500)).toBe(false);
  } finally {
    await liveTerminal?.kill();
    await reusedTerminal?.kill();
    if (replacementPid > 0 && processStart(replacementPid) === replacementStart) { process.kill(replacementPid, "SIGKILL"); }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
