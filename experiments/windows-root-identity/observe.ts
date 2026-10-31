/* eslint-disable no-await-in-loop -- Each phase deliberately follows the previous root's exit. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clock, object, read, syntheticBoundaries, waitFor, write, type ClockSample } from "#identity-support";

assert.equal(process.platform, "win32", "This read-only observation requires Windows.");
const output = resolvePath(process.argv[2] ?? "oar-trial-run/windows-root-identity");
mkdirSync(output, { recursive: true });
const started = performance.now();
const deadlineAt = started + 180_000;
const fixture = join(import.meta.dirname, "fixture.ts");
const reader = join(import.meta.dirname, "read.ps1");
const samples: Readonly<Record<string, unknown>>[] = [];
const fixtureDirectories: string[] = [];
const stopFiles = (): void => { for (const directory of fixtureDirectories) { write(join(directory, "stop-tool.json"), { clock: clock() }); } };
function emit(event: Readonly<Record<string, unknown>>): void {
  const record = { clock: clock(), ...event };
  appendFileSync(join(output, "events.jsonl"), `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
const watchdog = setTimeout(() => {
  emit({ kind: "watchdog", budgetMs: 210_000 });
  stopFiles();
  process.exit(124);
}, 210_000);

function query(label: string, pids: readonly number[], injected = false): Readonly<Record<string, unknown>> {
  const before = clock();
  const remaining = Math.floor(deadlineAt - performance.now());
  assert.ok(remaining > 0, "Observation budget exhausted before another query.");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", reader, "-ProcessIds", pids.join(",")];
  if (injected) { args.push("-InjectCimFailure"); }
  const result = spawnSync("powershell.exe", args, {
    encoding: "utf8", timeout: Math.min(8000, remaining), windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const after = clock();
  let parsed: unknown = null;
  let parseError: string | null = null;
  try { parsed = JSON.parse(result.stdout); } catch (error) { parseError = String(error); }
  const observation = {
    label, before, after, totalMs: after.monotonicMs - before.monotonicMs,
    status: result.status, signal: result.signal, error: result.error?.message ?? null,
    stderr: result.stderr, parsed, parseError,
  };
  emit({ kind: "query", ...observation });
  return observation;
}

function parsedObject(observation: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const value = observation.parsed;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? object(value) : null;
}

function nativeRoot(observation: Readonly<Record<string, unknown>>, pid: number): Record<string, unknown> | null {
  const values = parsedObject(observation)?.native;
  if (!Array.isArray(values)) { return null; }
  for (const value of values) { const row = object(value); if (row.pid === pid) { return row; } }
  return null;
}

function childBounds(observation: Readonly<Record<string, unknown>>, root: number, boundary: { before: ClockSample; exit: ClockSample }): readonly Readonly<Record<string, unknown>>[] {
  const payload = parsedObject(observation);
  if (payload === null) { return []; }
  const cim = object(payload.cim);
  if (cim.ok !== true || !Array.isArray(cim.rows)) { return []; }
  const epoch = 116_444_736_000_000_000n;
  const floor = BigInt(boundary.before.wallMs) * 10_000n + epoch;
  const lower = floor + 10_000n;
  const upper = BigInt(boundary.exit.wallMs) * 10_000n + epoch;
  return cim.rows.map((value: unknown) => object(value)).filter((row) => row.parentPid === root).map((row) => {
    const ticks = typeof row.creationFileTime === "string" ? BigInt(row.creationFileTime) : null;
    return { row, floorLowerFileTime: String(floor), tightenedLowerFileTime: String(lower), upperFileTime: String(upper),
      floorCandidate: ticks === null ? null : ticks > floor && ticks < upper,
      tightenedCandidate: ticks === null ? null : ticks > lower && ticks < upper };
  });
}

async function observe(mode: "normal" | "immediate" | "orphan", index: number): Promise<number> {
  const label = `${mode}-${index}`;
  const directory = join(output, label);
  mkdirSync(directory, { recursive: true });
  fixtureDirectories.push(directory);
  const beforeSpawn = clock();
  const child = spawn(process.execPath, [fixture, mode, directory], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  const inputErrors: string[] = [];
  child.stdin.on("error", (error: Error) => { inputErrors.push(error.message); });
  assert.ok(child.pid !== undefined, "The owned root must spawn.");
  const rootPid = child.pid;
  // No OpenProcess observer handle is held before this event. The experiment
  // blocks inside the callback so Node cannot run its queued handle endgame.
  // eslint-disable-next-line promise/avoid-new -- The synchronous exit callback is the measurement boundary.
  const exited = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const atExit = clock();
      try {
        const inside = query(`${label}/synchronous-exit`, [rootPid]);
        resolve({ code, signal, atExit, inside, childrenInInterval: childBounds(inside, rootPid, { before: beforeSpawn, exit: atExit }) });
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
  });
  // Attach rejection handling before readiness polling; retain the original error below.
  // eslint-disable-next-line promise/prefer-await-to-then -- Polling readiness runs concurrently with the required synchronous exit listener.
  void exited.catch(() => { /* The original rejection is awaited below. */ });
  let alive: Readonly<Record<string, unknown>> | null = null;
  try {
    if (mode !== "immediate") {
      await waitFor(join(directory, "root-ready.json"), 8000);
      alive = query(`${label}/alive`, [rootPid]);
      child.stdin.end("exit\n");
    }
    const exit = await exited;
    // A timer turn lets libuv process queued close/endgame work. Its completion
    // is an observation point, not a promise that some other observer holds no handle.
    await delay(25);
    const after = query(`${label}/after-callback`, [rootPid]);
    const inside = object(exit.inside);
    const held = nativeRoot(inside, rootPid);
    const released = nativeRoot(after, rootPid);
    const beforeExit = alive === null ? null : nativeRoot(alive, rootPid);
    const cim = parsedObject(inside)?.cim;
    const nativeIdentityAtExitObserved = held?.ok === true && held.handleClosed === true
      && held.exitCode === exit.code && typeof held.exitFileTime === "string" && BigInt(held.exitFileTime) > 0n
      && (mode === "immediate" || (beforeExit?.ok === true && held.creationFileTime === beforeExit.creationFileTime));
    const expectedTool = existsSync(join(directory, "tool-ready.json")) ? read(join(directory, "tool-ready.json")) : null;
    const cimRows = cim === undefined ? null : object(cim);
    const toolObserved = mode !== "orphan" || (expectedTool?.parentPid === rootPid && Array.isArray(cimRows?.rows)
      && cimRows.rows.some((value: unknown) => { const row = object(value); return row.pid === expectedTool.pid && row.parentPid === rootPid; }));
    const observation = {
      label, rootPid, beforeSpawn, alive, exit, after,
      expectedExitObserved: exit.code === (mode === "immediate" ? 7 : 0) && exit.signal === null,
      inputErrors,
      nativeIdentityAtExitObserved,
      cimReadSucceeded: cimRows?.ok === true,
      toolObserved,
      sameNativeIdentityStillReadable: held?.ok === true && released?.ok === true && held.creationFileTime === released.creationFileTime,
      differentIdentityAtSamePid: held?.ok === true && released?.ok === true && held.creationFileTime !== released.creationFileTime,
      tool: expectedTool,
    };
    samples.push(observation);
    write(join(directory, "result.json"), observation);
    emit({ kind: "case", label, rootPid, nativeIdentityAtExitObserved: observation.nativeIdentityAtExitObserved });
    return rootPid;
  } finally {
    child.stdin.destroy();
    write(join(directory, "stop-tool.json"), { clock: clock() });
    // Only this ChildProcess object is signalled on a broken fixture. No table
    // row or remembered PID is used as cleanup authority by the experiment.
    if (child.exitCode === null && child.signalCode === null) { child.kill(); }
  }
}

try {
  const boundaryExamples = syntheticBoundaries();
  write(join(output, "synthetic-counterexamples.json"), boundaryExamples);
  emit({ kind: "environment", node: process.version, uv: process.versions.uv, platform: process.platform, arch: process.arch });
  const roots: number[] = [];
  for (const mode of ["normal", "immediate", "orphan"] as const) {
    for (const index of [0, 1]) { roots.push(await observe(mode, index)); }
  }
  const failures = query("injected-cim-failure-and-invalid-pid", [0, process.pid], true);
  const failurePayload = parsedObject(failures);
  const failedCim = failurePayload?.cim === undefined ? null : object(failurePayload.cim);
  const invalidPid = nativeRoot(failures, 0);
  const failureEvidenceObserved = failedCim?.ok === false && failedCim.injected === true
    && typeof failedCim.error === "string" && invalidPid?.ok === false
    && invalidPid.stage === "OpenProcess" && invalidPid.error === 87;
  const reused: number[] = [];
  const attempted: number[] = [];
  for (let index = 0; index < 32 && performance.now() < deadlineAt - 8000; index++) {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 2000, windowsHide: true, stdio: "ignore" });
    attempted.push(result.pid);
    if (roots.includes(result.pid)) { reused.push(result.pid); }
  }
  const report = {
    node: process.version, uv: process.versions.uv, platform: process.platform, samples, failures, failureEvidenceObserved,
    pidReuse: { attempts: attempted, matchedPreviousRootPids: reused, status: reused.length === 0 ? "missing" : "PID number reuse observed; no descendant ownership inference" },
    syntheticCounterexamples: boundaryExamples,
    productAuthorization: "none; interval candidates and native queries are observations only",
  };
  write(join(output, "report.json"), report);
  if (!failureEvidenceObserved || samples.some((sample) => sample.nativeIdentityAtExitObserved !== true
    || sample.expectedExitObserved !== true || sample.cimReadSucceeded !== true || sample.toolObserved !== true
    || (Array.isArray(sample.inputErrors) && sample.inputErrors.length > 0))) { process.exitCode = 1; }
} finally {
  stopFiles();
  clearTimeout(watchdog);
}
