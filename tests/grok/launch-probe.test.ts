/* oxlint-disable eslint/require-await, eslint/max-statements -- Async dependency controls and complete lifecycle assertions stay together. */
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LaunchLeakError, probeLaunch, type LaunchVariant } from "../../experiments/grok-startup/launch-probe.js";
import { observeProcessTableWithin } from "../../packages/oar/src/shared/executable/process-table-budget.js";
import { type ProcessEntry, type ProcessTableObservation } from "../../packages/oar/src/shared/executable/process-tree.js";
import { signalProcessGroup } from "../../packages/oar/src/shared/executable/process.js";

const fixture: LaunchVariant = { name: "synthetic", command: process.execPath, pipes: "pipe", args: ["-e", `
  process.stdin.once('data', () => {
    process.stderr.write('token=' + process.env.TEST_API_KEY + '\\nlast line');
    process.stdout.write(JSON.stringify({id:1,result:{protocolVersion:1}})+'\\n');
  });
  setInterval(()=>{},1000);
`] };
const env = { TEST_API_KEY: "synthetic-launch-secret-123456789" };
type Row = Readonly<Record<string, unknown>>;
const unavailable = async (): Promise<ProcessTableObservation> => ({ ok: false, source: "windows", elapsedMs: 1000, reason: "timeout" });
function table(entries: ProcessEntry[]): ProcessTableObservation {
  return { ok: true, source: "procfs", skipped: 0, elapsedMs: 1, table: new Map(entries.map(entry => [entry.pid, entry])) };
}
function identity(child: ChildProcessWithoutNullStreams, start = "original"): ProcessEntry {
  return { pid: child.pid ?? 0, ppid: process.pid, pgid: 0, start };
}

// These controls deliberately omit termination. Always reap their real child,
// including when an assertion fails, using its ChildProcess rather than a PID.
async function reap(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) { return; }
  const closed = Promise.withResolvers<void>();
  child.once("exit", () => { closed.resolve(); });
  signalProcessGroup(child, "SIGKILL");
  await closed.promise;
}

test("native initialize and cleanup retain exit, stderr and timing without exposing credentials", async () => {
  const rows: Row[] = [];
  const result = await probeLaunch(fixture, env, { record: row => { rows.push(row); } });
  expect(result.outcome).toBe("initialized");
  expect(result.didClose).toBe(true);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ phase: "result", outcome: "initialized", didClose: true });
  const text = JSON.stringify(rows);
  expect(text).toContain('"phase":"exit"');
  expect(text).toContain('"phase":"close"');
  expect(text).toContain("last line");
  expect(text).not.toContain(env.TEST_API_KEY);
}, 20_000);

test("missing close plus failed identity reads is a recorded uncertainty", async () => {
  const rows: Row[] = [];
  const captured: { child: ChildProcessWithoutNullStreams | undefined } = { child: undefined };
  try {
    const result = await probeLaunch(fixture, env, { record: row => { rows.push(row); },
      cleanupMs: 20, observe: unavailable, stop: async processChild => { captured.child = processChild; return ({ method: "deliberately_omitted" }); },
    });
    expect(result).toEqual({ outcome: "initialized", cleanup: "unverified", didClose: false });
    expect(JSON.stringify(rows)).toContain('"reason":"timeout"');
    expect(rows[0]).toMatchObject({ exitCode: null, cleanup: "unverified" });
  } finally { await reap(captured.child); }
});

test("a native surviving process fails only after its lifecycle record is written", async () => {
  const rows: Row[] = [];
  const captured: { child: ChildProcessWithoutNullStreams | undefined } = { child: undefined };
  try {
    await expect(probeLaunch(fixture, env, { record: row => { rows.push(row); },
      cleanupMs: 20, observe: async () => observeProcessTableWithin(5000),
      stop: async processChild => { captured.child = processChild; return ({ method: "deliberately_omitted" }); },
    })).rejects.toBeInstanceOf(LaunchLeakError);
    expect(rows[0]).toMatchObject({ cleanup: "leaked", pid: captured.child?.pid, exitCode: null });
    expect(JSON.stringify(rows)).toContain('"phase":"cleanup_observed"');
    expect(JSON.stringify(rows)).toContain('"survivors":[{');
  } finally { await reap(captured.child); }
}, 20_000);

test("a reused PID in synthetic snapshots cannot establish a leak", async () => {
  const rows: Row[] = [];
  const captured: { child: ChildProcessWithoutNullStreams | undefined } = { child: undefined };
  let reads = 0;
  try {
    const result = await probeLaunch(fixture, env, { record: row => { rows.push(row); },
      cleanupMs: 20, observe: async processChild => table([identity(processChild, ++reads === 1 ? "original" : "replacement")]),
      stop: async processChild => { captured.child = processChild; return ({ method: "deliberately_omitted" }); },
    });
    expect(result.cleanup).toBe("observed_gone");
    expect(JSON.stringify(rows)).toContain('"survivors":[]');
  } finally { await reap(captured.child); }
});

test("a captured descendant surviving after root close still fails with its identity", async () => {
  const rows: Row[] = [];
  const descendant: ProcessEntry = { pid: 999_999, ppid: 0, pgid: 0, start: "synthetic-descendant" };
  let reads = 0;
  await expect(probeLaunch(fixture, env, { record: row => { rows.push(row); },
    observe: async child => {
      reads += 1;
      return reads === 1 ? table([identity(child), { ...descendant, ppid: child.pid ?? 0 }]) : table([descendant]);
    },
  })).rejects.toBeInstanceOf(LaunchLeakError);
  expect(rows[0]).toMatchObject({ didClose: true, cleanup: "leaked" });
  expect(JSON.stringify(rows)).toContain("synthetic-descendant");
});

test("termination and observation errors still preserve the terminal record", async () => {
  const rows: Row[] = [];
  const captured: { child: ChildProcessWithoutNullStreams | undefined } = { child: undefined };
  try {
    const result = await probeLaunch(fixture, env, { record: row => { rows.push(row); },
      cleanupMs: 20, observe: async () => { throw new Error("synthetic observation failure"); },
      stop: async processChild => { captured.child = processChild; throw new Error("synthetic stop failure"); },
    });
    expect(result.cleanup).toBe("unverified");
    expect(JSON.stringify(rows)).toContain("termination_error");
    expect(JSON.stringify(rows)).toContain("read_failed");
  } finally { await reap(captured.child); }
});

test("missing executable and native refusal retain outcomes without a diagnostic assertion", async () => {
  const rows: Row[] = [];
  const missing = await probeLaunch({ ...fixture, command: path.join(tmpdir(), "missing-grok-probe-executable") }, env, { record: row => { rows.push(row); } });
  expect(missing.outcome).toBe("spawn_error");
  const refused = await probeLaunch({ ...fixture, args: ["-e", String.raw`process.stderr.write('refused\n'); process.exit(23)`] }, env, { record: row => { rows.push(row); } });
  expect(refused.outcome).toBe("exited");
  expect(rows.at(-1)).toMatchObject({ exitCode: 23, stderr: "refused\n" });
});

test("CLI setup failure is persisted and does not turn the optional diagnostic red", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "grok-launch-diagnostic-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "experiments/grok-acp-startup.ts", path.join(directory, "absent-npm-root")], {
      encoding: "utf8", timeout: 30_000, windowsHide: true, env: { ...process.env, OAR_TRIAL_RUN_DIR: directory },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(directory, "grok-acp-startup.jsonl"), "utf8")).toContain('"phase":"diagnostic_error"');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
