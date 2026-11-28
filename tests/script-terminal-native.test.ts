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

async function createPidReuseFixture(): Promise<{
  readonly dir: string;
  readonly program: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oar-script-reuse-"));
  const program = path.join(dir, "program.sh");
  await writeFile(program, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
  const replacement = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const pid = replacement.pid ?? 0;
  const startedAt = processStart(pid) ?? "";
  expect(pid).toBeGreaterThan(0);
  expect(startedAt).not.toBe("");
  return {
    dir,
    program,
    pid,
    startedAt,
    cleanup: async () => {
      if (pid > 0 && processStart(pid) === startedAt) { process.kill(pid, "SIGKILL"); }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function openLinuxReuseTerminal(spec: { dir: string; program: string; hostPid: number; startedAt: string }): NonNullable<ReturnType<typeof openScriptTerminal>> {
  const terminal = openScriptTerminal({ command: spec.program, cwd: spec.dir, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24, platform: "linux" }, {
    findScript: findScriptUtility,
    spawn,
    listProcesses: () => [{ pid: spec.hostPid, parentPid: 1, startedAt: spec.startedAt }],
    signal: (targetPid: number, sig: NodeJS.Signals) => { process.kill(targetPid, sig); },
    hostPid: spec.hostPid,
  });
  expect(terminal).not.toBeNull();
  if (terminal === null) { throw new Error("expected script terminal"); }
  terminal.onData(() => {});
  return terminal;
}

test.skipIf(process.platform !== "linux" || findScriptUtility() === null)("watchdog stops when live hostPid has a different start time (PID reuse) and stays alive when it matches", async () => {
  const fixture = await createPidReuseFixture();
  const liveTerminal = openLinuxReuseTerminal({ dir: fixture.dir, program: fixture.program, hostPid: fixture.pid, startedAt: fixture.startedAt });
  const reusedTerminal = openLinuxReuseTerminal({ dir: fixture.dir, program: fixture.program, hostPid: fixture.pid, startedAt: `${fixture.startedAt}999` });
  try {
    expect(await waitForExit(reusedTerminal, 6000)).toBe(true);
    expect(await waitForExit(liveTerminal, 1500)).toBe(false);
  } finally {
    await liveTerminal.kill();
    await reusedTerminal.kill();
    await fixture.cleanup();
  }
}, 20_000);
