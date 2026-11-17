/* oxlint-disable import/max-dependencies -- Standalone diagnostic reuses process identity, spawn and redaction policy. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";
import { OWN_PROCESS_GROUP, signalProcessGroup } from "../../packages/oar/src/shared/executable/process.js";
import { observeProcessTableWithin } from "../../packages/oar/src/shared/executable/process-table-budget.js";
import { descendantsOf, type ProcessEntry, type ProcessTableObservation } from "../../packages/oar/src/shared/executable/process-tree.js";
import { windowsSpawnTarget } from "../../packages/oar/src/shared/executable/windows-shim.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

export interface LaunchVariant {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly pipes: "pipe" | "overlapped";
}
type Row = Readonly<Record<string, unknown>>;
interface ProbeOptions {
  readonly record: (row: Row) => void;
  readonly initializeMs?: number;
  readonly cleanupMs?: number;
  readonly observe?: (child: ChildProcessWithoutNullStreams) => Promise<ProcessTableObservation>;
  readonly stop?: (child: ChildProcessWithoutNullStreams, limitMs: number) => Promise<Row>;
}

export class LaunchLeakError extends Error {
  constructor() { super("Launch diagnostic observed an owned process surviving cleanup; inspect the recorded lifecycle"); this.name = "LaunchLeakError"; }
}

/** Keep taskkill itself bounded so an optional probe cannot hold its host open. */
async function stop(child: ChildProcessWithoutNullStreams, limitMs: number): Promise<Row> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) { return { method: "already_exited_or_not_spawned" }; }
  if (process.platform !== "win32") {
    signalProcessGroup(child, "SIGKILL");
    return { method: "process_group_sigkill" };
  }
  try {
    // oxlint-disable-next-line typescript/strict-void-return -- Node returns a ChildProcess; promisify uses its completion callback.
    await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: limitMs });
    return { method: "taskkill", ok: true };
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Native exit fields can change while taskkill is awaited.
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); }
    const native = asRecord(error);
    const code = native?.code;
    return { method: "taskkill", ok: false, code: typeof code === "number" || typeof code === "string" && /^[A-Z_]+$/u.test(code) ? code : null,
      killed: native?.killed === true };
  }
}

function observation(result: ProcessTableObservation): Row {
  if (!result.ok) { return { ...result }; }
  return { ok: true, source: result.source, elapsedMs: result.elapsedMs, skipped: result.skipped };
}

export interface LaunchResult {
  readonly outcome: string;
  readonly cleanup: "observed_gone" | "unverified" | "leaked";
  readonly didClose: boolean;
}

/** Persist the terminal record in finally before deciding whether a leak fails the job. */
export async function probeLaunch(variant: LaunchVariant, fixtureEnv: Readonly<Record<string, string>>, options: ProbeOptions): Promise<LaunchResult> {
  const env = sessionEnvironment(fixtureEnv);
  const { redact } = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null])) });
  const privatePaths = [env.HOME, env.USERPROFILE, env.GROK_HOME].filter((value): value is string => value !== undefined && value !== "");
  const target = windowsSpawnTarget(variant.command, variant.args, { env });
  const startedAt = Date.now();
  const started = performance.now();
  const child = spawn(target.command, [...target.args], {
    env, detached: OWN_PROCESS_GROUP, windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments ?? false,
    stdio: [variant.pipes, variant.pipes, variant.pipes],
  });
  const lifecycle: Row[] = [];
  const phase = (name: string, facts: Row = {}): void => { lifecycle.push({ phase: name, at: Date.now(), elapsedMs: performance.now() - started, ...facts }); };
  phase("spawn_returned", { pid: child.pid ?? null });
  const closed = Promise.withResolvers<boolean>();
  const answer = Promise.withResolvers<string>();
  child.once("spawn", () => { phase("spawned"); });
  child.once("close", (code, signal) => { phase("close", { code, signal }); closed.resolve(true); });
  child.once("exit", (code, signal) => { phase("exit", { code, signal }); answer.resolve("exited"); });
  child.once("error", () => { phase("spawn_error"); answer.resolve("spawn_error"); });
  child.stdin.on("error", () => { phase("stdin_error"); answer.resolve("stdin_error"); });
  let stderr = "";
  let stdoutBytes = 0;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = asRecord(parseJson(line));
    if (message?.id === 1) {
      phase("initialize_response");
      answer.resolve(typeof asRecord(message.result)?.protocolVersion === "number" ? "initialized" : "native_error");
    }
  });
  const timer = setTimeout(() => { answer.resolve("timed_out"); }, options.initializeMs ?? 15_000);
  let outcome = "probe_error";
  let elapsedMs = 0;
  let cleanup: LaunchResult["cleanup"] = "unverified";
  let didClose = false;
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1, clientInfo: { name: "oar", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    } })}\n`);
    phase("initialize_sent");
    outcome = await answer.promise;
  } catch { phase("probe_error"); }
  finally {
    elapsedMs = performance.now() - started;
    clearTimeout(timer);
    lines.close();
    const observe = async (processChild: ChildProcessWithoutNullStreams): Promise<ProcessTableObservation> => {
      try { return options.observe === undefined ? await observeProcessTableWithin(1000) : await options.observe(processChild); }
      catch { return { ok: false, source: process.platform === "win32" ? "windows" : "procfs", reason: "read_failed", elapsedMs: 0 }; }
    };
    const before = await observe(child);
    const root = before.ok && child.pid !== undefined ? before.table.get(child.pid) : undefined;
    // A table read after root exit cannot establish ownership of a reused PID.
    const owned: readonly ProcessEntry[] = before.ok && root !== undefined && root.ppid === process.pid
      && child.exitCode === null && child.signalCode === null ? [root, ...descendantsOf(before.table, root.pid, before.source)] : [];
    phase("cleanup_requested", { owned, observation: observation(before) });
    const limitMs = options.cleanupMs ?? 5000;
    const cleanupTimer = setTimeout(() => { closed.resolve(false); }, limitMs);
    let termination: Row = {};
    try { [didClose, termination] = await Promise.all([closed.promise, (options.stop ?? stop)(child, limitMs).catch(() => ({ method: "termination_error" }))]); }
    finally { clearTimeout(cleanupTimer); }
    const after = await observe(child);
    const survivors = after.ok ? owned.filter(entry => after.table.get(entry.pid)?.start === entry.start) : [];
    if (survivors.length > 0) { cleanup = "leaked"; }
    else if (owned.length > 0 && after.ok && after.skipped === 0) { cleanup = "observed_gone"; }
    phase("cleanup_observed", { didClose, termination, survivors, observation: observation(after) });
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    let safeStderr = redact(stderr);
    for (const value of privatePaths) { safeStderr = safeStderr.replaceAll(value, "[fixture-path]"); }
    const stderrTail = safeStderr.split(/\r?\n/u).slice(-8).map(line => line.length > 512 ? "[long line omitted]" : line);
    options.record({ phase: "result", name: variant.name, outcome, startedAt, elapsedMs, totalMs: performance.now() - started,
      pid: child.pid ?? null, exitCode: child.exitCode, exitSignal: child.signalCode, stdoutBytes, stderr: stderrTail.join("\n"),
      cleanup, didClose, lifecycle });
  }
  if (cleanup === "leaked") { throw new LaunchLeakError(); }
  return { outcome, cleanup, didClose };
}
