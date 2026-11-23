import { holdFixtureDeadline } from "./fixtures/fixture-deadline.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { assertRan } from "../packages/oar/src/shared/executable/diagnostics.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { spawnLineProcess, type LineProcess } from "../packages/oar/src/shared/executable/process.js";
import { PIPE_CLOSE_MS } from "../packages/oar/src/shared/executable/pipe-close.js";
// oxlint-disable-next-line import/max-dependencies -- Verify real holder identities alongside the pipe-close and observation seams.
import { eventually, gone, fixtureIdentityPath, reportedProcess, reportShellChild, type ProcessIdentity, signalFixture } from "./fixtures/process-tree.js";

// Seams: an unreadable process table, slow cleanup reads, a failing pipe wait.
const seams = vi.hoisted(() => ({ tableFails: false, cleanupReadDelayMs: 0, closeThrows: false }));
vi.mock("../packages/oar/src/shared/executable/process-table-async.js", async (importOriginal) => {
  const actual = await importOriginal<{ readonly observeProcessTableAsync: (...args: unknown[]) => Promise<unknown>; readonly processTableSource: () => string }>();
  return {
    ...actual,
    observeProcessTableAsync: async (...args: unknown[]) => {
      if (seams.tableFails) { return { ok: false as const, source: actual.processTableSource(), reason: "timeout" as const, elapsedMs: 0 }; }
      const observed = await actual.observeProcessTableAsync(...args);
      return observed;
    },
  };
});
vi.mock("../packages/oar/src/shared/executable/process-table-budget.js", async (importOriginal) => {
  const actual = await importOriginal<{ readonly observeProcessTableWithin: (...args: unknown[]) => Promise<unknown> }>();
  return {
    ...actual,
    observeProcessTableWithin: async (...args: unknown[]) => {
      if (seams.cleanupReadDelayMs > 0) { await delay(seams.cleanupReadDelayMs); }
      const observed = await actual.observeProcessTableWithin(...args);
      return observed;
    },
  };
});
vi.mock("../packages/oar/src/shared/executable/pipe-close.js", async (importOriginal) => {
  const actual = await importOriginal<{ readonly closePipesAfterExit: (...args: unknown[]) => Promise<unknown> }>();
  return {
    ...actual,
    closePipesAfterExit: async (...args: unknown[]) => {
      if (seams.closeThrows) { throw new Error("pipe wait failed"); }
      const held = await actual.closePipesAfterExit(...args);
      return held;
    },
  };
});

// A runtime's root exits (or is killed) while something it started keeps its
// output pipes: a background job, or, through a `sudo -u` wrapper, another
// user's tree OAR may not signal (EPERM). Neither may make OAR wait for them
// without a limit; what OAR then cuts off is reported, never passed as whole.
// Cross-user evidence: experiments/cross-user-kill/README.md.
const posix = process.platform !== "win32";
const realKill = process.kill.bind(process);
const started: ProcessIdentity[] = [];
const scratch: string[] = [];

afterEach(() => {
  Object.assign(seams, { tableFails: false, cleanupReadDelayMs: 0, closeThrows: false });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const pid of started.splice(0)) { signalFixture(pid); }
  for (const directory of scratch.splice(0)) { rmSync(directory, { recursive: true, force: true }); }
});

/** A root that starts a background `sleep` holding its stdout and stderr, prints the sleep's pid, then exits at once or waits for stdin to close. */
const leaveHolder = (exit: "now" | "on-eof"): readonly string[] => ["-c", `sleep 60 & ${reportShellChild}; ${exit === "now" ? "exit 0" : "cat > /dev/null"}`];
/** A root (node) that starts a `sleep` in a session of its own, outside the root's process group, holding its stdout and stderr. */
const leaveHolderOutsideGroup = ["-e", `const c = require("node:child_process").spawn("sleep", ["60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); c.unref(); console.log(JSON.stringify(require(${JSON.stringify(fixtureIdentityPath)}).captureProcess(c.pid)));`];
/** `heldPipes` with its timing reduced to its type, to compare the rest exactly. */
const shape = <T extends { readonly waitedMs: number }>(held: T | undefined): (Omit<T, "waitedMs"> & { readonly waitedMs: string }) | undefined =>
  held === undefined ? held : { ...held, waitedMs: typeof held.waitedMs };
const HUNG = "hung";
const within = async <T>(work: Promise<T>, ms = 10_000): Promise<Awaited<T> | typeof HUNG> => {
  const result = await Promise.race([work, delay<typeof HUNG>(ms, HUNG, { ref: false })]);
  return result;
};

/**
 * Signals as `sudo -u` makes them: the root's group signal reaches the root
 * alone, and the holder refuses every signal with EPERM.
 */
function holderOutOfReach(root: () => number | undefined, holder: () => number | undefined): void {
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    const target = root();
    if (pid === holder()) { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); }
    if (target !== undefined && pid === -target) { return realKill(target, signal); }
    return realKill(pid, signal);
  });
}

/** A line process running `command args`, with exit reasons collected, once it printed its holder's pid. */
async function lineProcessWithHolder(command: string, args: readonly string[], options: { readonly extraPipe?: boolean } = {}): Promise<{ readonly child: LineProcess; readonly holder: ProcessIdentity; readonly reasons: (string | undefined)[] }> {
  const child = spawnLineProcess(command, args, { killTree: true, ...options });
  const printed = Promise.withResolvers<string>();
  child.onLine((line) => { printed.resolve(line); });
  const reasons: (string | undefined)[] = [];
  child.onExit((_code, reason) => { reasons.push(reason); });
  const holder = reportedProcess(JSON.parse(await printed.promise));
  started.push(holder);
  return { child, holder, reasons };
}

/** The holder's pid and the root's, which the root writes to a file before it waits. */
async function recordedPids(file: string): Promise<{ readonly holder: ProcessIdentity; readonly root: number }> {
  expect(await eventually(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"), 5000)).toBe(true);
  const row: unknown = JSON.parse(readFileSync(file, "utf8"));
  const holder = reportedProcess(row);
  if (typeof row !== "object" || row === null || !("root" in row) || typeof row.root !== "number") { throw new Error("Missing fixture root PID"); }
  const { root } = row;
  started.push(holder);
  return { holder, root };
}

const scratchDir = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-test-held-pipes-"));
  scratch.push(directory);
  return directory;
};

test.skipIf(!posix)("a session whose root exits leaving a background job on its pipes settles within the limit and names the holder", async () => {
  const { child, holder, reasons } = await lineProcessWithHolder("sh", leaveHolder("now"));
  const begun = performance.now();
  expect(await within(child.exited)).toBe(0);
  const waited = performance.now() - begun;
  const { cleanup } = child.diagnostics();
  expect({ waited: waited >= PIPE_CLOSE_MS - 100 && waited < PIPE_CLOSE_MS + 3000, stdoutClosed: child.stdout.destroyed, cleanup: cleanup === undefined ? cleanup : { ...cleanup, heldPipes: shape(cleanup.heldPipes) } })
    .toEqual({ waited: true, stdoutClosed: true, cleanup: { status: "observed", observations: [], heldPipes: { waitedMs: "number", pipes: ["stdout", "stderr"], holders: [holder.pid] } } });
  expect(reasons[0]).toBe(`Output pipes (stdout, stderr) still open ${String(child.diagnostics().cleanup?.heldPipes?.waitedMs)} ms after the root exited (left in the root's process group: pids ${String(holder.pid)}); OAR closed its end, so output may be incomplete`);
  // OAR reports the holder; it does not end a job the runtime left on its own.
  expect(await gone(holder, 50)).toBe(false);
});

// Review B2: a holder that left the root's group (as another user's tree under sudo can) cannot be named; the session lets go anyway.
test.skipIf(!posix)("a session whose pipes are held by a process outside the root's process group still closes its end, naming no holder", async () => {
  const { child } = await lineProcessWithHolder(process.execPath, leaveHolderOutsideGroup);
  expect(await within(child.exited)).toBe(0);
  expect({ closed: child.stdout.destroyed, heldPipes: shape(child.diagnostics().cleanup?.heldPipes) })
    .toEqual({ closed: true, heldPipes: { waitedMs: "number", pipes: ["stdout", "stderr"], holders: [] } });
  expect(child.diagnostics().cleanup?.status).toBe("observed");
});

test.skipIf(!posix)("kill() when the holder is out of reach (EPERM): nothing hangs, the holder is reported, and no cleanup failure is", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "200");
  const { child, holder } = await lineProcessWithHolder("sh", leaveHolder("on-eof"));
  holderOutOfReach(() => child.pid, () => holder.pid);
  child.kill();
  // The root went (EOF or the SIGTERM, whichever came first); its exit was not held up by the holder.
  const exited = await within(child.exited);
  const { cleanup } = child.diagnostics();
  expect({ settled: exited !== HUNG, status: cleanup?.status, holders: cleanup?.heldPipes?.holders }).toEqual({ settled: true, status: "observed", holders: [holder.pid] });
  expect(cleanup?.foreign).toBe(1);
  expect(await gone(holder, 50)).toBe(false);
});

test.skipIf(!posix)("OAR closes only the pipe a process holds: a paused pipe nobody holds keeps its unread data", async () => {
  // The holder keeps stderr only; the root wrote to its private pipe, which its consumer has not read yet.
  // `(exec sleep)`, as in process-held-pipes-readers.test.ts: a shell running `sleep` itself keeps a saved copy of stdout.
  const { child, holder } = await lineProcessWithHolder("sh", ["-c", `printf unread >&3; exec 3>&-; (exec sleep 60) >/dev/null & ${reportShellChild}; exit 0`], { extraPipe: true });
  const extra = child.extraPipe;
  extra?.on("readable", () => {});
  expect(await within(child.exited)).toBe(0);
  expect({ extraOpen: extra?.destroyed === false, heldPipes: shape(child.diagnostics().cleanup?.heldPipes) })
    .toEqual({ extraOpen: true, heldPipes: { waitedMs: "number", pipes: ["stderr"], holders: [holder.pid] } });
  expect(String(extra?.read())).toBe("unread");
});

test.skipIf(!posix)("a command whose output a holder cuts short fails as possibly incomplete instead of ok (review repro)", async () => {
  // The maintainer's reproduction: LATE comes after the limit, so OAR cannot have read it.
  const result = await within(runExecutable("sh", ["-c", "(sleep 2.5; echo LATE) & echo EARLY; exit 0"], { timeoutMs: 0 }));
  if (result === HUNG) { throw new Error("hung"); }
  expect({ ok: result.ok, stdout: result.stdout, exitCode: result.exitCode, error: result.diagnostics?.error?.code, pipes: result.diagnostics?.cleanup?.heldPipes?.pipes })
    .toEqual({ ok: false, stdout: "EARLY\n", exitCode: null, error: "OUTPUT_INCOMPLETE", pipes: ["stdout", "stderr"] });
  expect(() => { assertRan(result, "probe"); }).toThrow(/OUTPUT_INCOMPLETE.*still open \d+ ms after the root exited \(left in the root's process group: pids [\d, ]+\).*output may be incomplete/u);
});

/** Capture the long-lived holder as soon as its root starts it, before waiting for the result. */
async function runWithHolder() {
  const file = path.join(scratchDir(), "pids");
  const pending = runExecutable("sh", ["-c", `sleep 60 & ${reportShellChild} > "$OAR_TEST_PIDS"; echo "$!"; exit 0`], {
    timeoutMs: 0, env: { ...process.env, OAR_TEST_PIDS: file },
  });
  const { holder } = await recordedPids(file);
  return { holder, result: await within(pending) };
}

test.skipIf(!posix)("a command with no deadline whose root exits leaving a holder resolves after the limit with the holder", async () => {
  const { holder, result } = await runWithHolder();
  expect(result === HUNG ? result : { ok: result.ok, holders: result.diagnostics?.cleanup?.heldPipes?.holders }).toEqual({ ok: false, holders: [holder.pid] });
});

test.skipIf(!posix)("a timed-out command whose holder OAR may not signal (EPERM) settles instead of waiting for it", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "200");
  const pids = path.join(scratchDir(), "pids");
  const waitForFixture = holdFixtureDeadline();
  const pending = runExecutable("sh", ["-c", `sleep 60 & ${reportShellChild} > "$OAR_TEST_PIDS"; cat > /dev/null`], { timeoutMs: 1500, env: { ...process.env, OAR_TEST_PIDS: pids } });
  const holder = await waitForFixture(pending, async () => {
    const pidsRead = await recordedPids(pids);
    holderOutOfReach(() => pidsRead.root, () => pidsRead.holder.pid);
    return pidsRead.holder;
  });
  const result = await within(pending);
  expect(result === HUNG ? result : { ok: result.ok, timeoutMs: result.diagnostics?.timeoutMs, holders: result.diagnostics?.cleanup?.heldPipes?.holders })
    .toEqual({ ok: false, timeoutMs: 1500, holders: [holder.pid] });
});

test.skipIf(!posix)("a stopped command's wait for its pipes starts at the SIGKILL: a tool that only the SIGKILL ends is not reported as a holder", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "200");
  // Each cleanup read takes longer than the kill grace plus the limit, as on a loaded machine.
  seams.cleanupReadDelayMs = PIPE_CLOSE_MS + 500;
  const pids = path.join(scratchDir(), "pids");
  const waitForFixture = holdFixtureDeadline();
  const pending = runExecutable("sh", ["-c", `(trap "" TERM; exec sleep 60) & ${reportShellChild} > "$OAR_TEST_PIDS"; exec sleep 60`], { timeoutMs: 300, env: { ...process.env, OAR_TEST_PIDS: pids } });
  const { holder } = await waitForFixture(pending, async () => recordedPids(pids));
  const result = await within(pending, 20_000);
  expect(result === HUNG ? result : { ok: result.ok, timeoutMs: result.diagnostics?.timeoutMs, cleanup: result.diagnostics?.cleanup }).toEqual({ ok: false, timeoutMs: 300, cleanup: undefined });
  expect(await gone(holder)).toBe(true);
});

test.skipIf(!posix)("a failed wait for the pipes still settles the command and closes them", async () => {
  seams.closeThrows = true;
  const { result } = await runWithHolder();
  if (result === HUNG) { throw new Error("hung"); }
  expect({ ok: result.ok, error: result.diagnostics?.error?.message }).toEqual({ ok: false, error: "pipe wait failed" });
});

test.skipIf(!posix)("a command whose holders cannot be looked for (the process table unreadable) resolves after the limit, unverified, with that read kept", async () => {
  seams.tableFails = true;
  const { result } = await runWithHolder();
  const cleanup = result === HUNG ? undefined : result.diagnostics?.cleanup;
  expect(result === HUNG ? result : { ok: result.ok, cleanup: cleanup === undefined ? cleanup : { ...cleanup, heldPipes: shape(cleanup.heldPipes) } }).toEqual({ ok: false, cleanup: {
    status: "unverified",
    observations: [{ ok: false, source: process.platform === "linux" ? "procfs" : "ps", reason: "timeout", elapsedMs: 0, phase: "pipe_holders" }],
    heldPipes: { waitedMs: "number", pipes: ["stdout", "stderr"], holders: [] },
  } });
  if (result !== HUNG) { expect(() => { assertRan(result, "probe"); }).toThrow(/could not be verified: pipe_holders .*no holder identified/u); }
});
