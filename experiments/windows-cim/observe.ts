/* eslint-disable no-await-in-loop -- Sequential and paired timing cohorts must keep their measured ordering. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { availableParallelism } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

if (process.platform !== "win32") {
  throw new Error("This observation needs Windows and powershell.exe.");
}
const output = resolve(process.argv[2] ?? "oar-trial-run/windows-cim");
mkdirSync(output, { recursive: true });
const started = performance.now();
interface SampleResult {
  readonly variant: string;
  readonly phase: string;
  readonly index: number;
  readonly target: number;
  readonly bornAt: string;
  readonly spawnAt: string;
  readonly timeoutMs: number;
  readonly totalMs: number;
  readonly ok: boolean;
  readonly error: { readonly code: string | number | null; readonly signal: string | null; readonly killed: boolean } | null;
  readonly parseError: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly parsed: unknown;
}
interface Group { attempts: number; failures: number; totalsMs: number[]; queryMs: number[]; completedOver5s: number }
const owned = new Set<ChildProcess>();
const results: SampleResult[] = [];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parse(text: string): unknown { return JSON.parse(text); }
function asRecord(value: unknown): Record<string, unknown> | null { return isRecord(value) ? value : null; }
const eventsFile = resolve(output, "events.jsonl");
writeFileSync(eventsFile, "");
function emit(event: Readonly<Record<string, unknown>>): void {
  const record = { utc: new Date().toISOString(), elapsedMs: performance.now() - started, ...event };
  appendFileSync(eventsFile, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
interface Distribution { readonly n: number; readonly min: number; readonly median: number; readonly max: number }
interface GroupSummary { readonly attempts: number; readonly failures: number; readonly totalsMs: Distribution | null; readonly queryMs: Distribution | null; readonly completedOver5s: number }
function distribution(values: readonly number[]): Distribution | null {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted.length === 0 ? null : { n: sorted.length, min: sorted[0] ?? 0, median: ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) + (sorted[Math.floor(sorted.length / 2)] ?? 0)) / 2, max: sorted.at(-1) ?? 0 };
}
function summary(): Record<string, GroupSummary> {
  const groups: Record<string, Group> = {};
  for (const result of results) {
    const key = `${result.variant}/${result.phase}`;
    let group = groups[key];
    if (group === undefined) {
      group = { attempts: 0, failures: 0, totalsMs: [], queryMs: [], completedOver5s: 0 };
      groups[key] = group;
    }
    group.attempts++;
    if (result.ok) {
      group.totalsMs.push(result.totalMs);
      const queryMs = asRecord(result.parsed)?.queryMs;
      if (typeof queryMs === "number") { group.queryMs.push(queryMs); }
      if (result.totalMs > 5000) { group.completedOver5s++; }
    } else { group.failures++; }
  }
  return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { ...group, totalsMs: distribution(group.totalsMs), queryMs: distribution(group.queryMs) }]));
}
function persist(partial: boolean): void {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify({ platform: process.platform, node: process.version, partial, summary: summary(), results }, null, 2)}\n`);
}
// Keep partial evidence even if a killed shell never closes its output pipes.
const deadline = setTimeout(() => {
  emit({ kind: "overall_deadline", budgetMs: 480_000 });
  persist(true);
  for (const child of owned) { try { child.kill(); } catch { /* Already gone. */ } }
  process.exit(124);
}, 480_000);
const select = "Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}";
const query = (variant: string): string => `Get-CimInstance Win32_Process${variant === "projected" ? " -Property ProcessId,ParentProcessId,CreationDate" : ""} | ${select}`;
const exact = `${query("full")} | ConvertTo-Json -Compress`;
const preamble = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';";
function measured(variant: string, target: number, loadPids: readonly number[]): string {
  const loadQuery = loadPids.length === 0 ? "$null" : `@(Get-Process -Id ${loadPids.join(",")} -ErrorAction Stop | Select-Object Id,CPU)`;
  return `${preamble}
$loadBefore = ${loadQuery}
$loadBeforeAt = [DateTime]::UtcNow.ToString('o')
$watch = [Diagnostics.Stopwatch]::StartNew()
$rows = @(${query(variant)})
$duration = $watch.Elapsed.TotalMilliseconds
$entry = $rows | Where-Object { $_.ProcessId -eq ${target} } | Select-Object -First 1
$loadAfter = ${loadQuery}
$loadAfterAt = [DateTime]::UtcNow.ToString('o')
@{queryMs=$duration; count=$rows.Count; targetSeen=($null -ne $entry); target=$entry;loadBefore=$loadBefore;loadAfter=$loadAfter;loadBeforeAt=$loadBeforeAt;loadAfterAt=$loadAfterAt} | ConvertTo-Json -Compress -Depth 4`;
}
function visibility(variant: string, target: number): string {
  return `${preamble}
function Emit($item) { $item | ConvertTo-Json -Compress -Depth 4; [Console]::Out.Flush() }
for ($round = 0; $round -lt 12; $round++) {
  $before = [DateTime]::UtcNow
  $native = Get-Process -Id ${target} -ErrorAction SilentlyContinue
  $nativeStarted = if ($null -ne $native) { $native.StartTime.ToUniversalTime().ToString('o') } else { $null }
  Emit @{kind='query_start';round=$round;beforeUtc=$before.ToString('o');getProcessBefore=($null -ne $native);targetStartedUtc=$nativeStarted}
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $rows = @(${query(variant)})
  $duration = $watch.Elapsed.TotalMilliseconds
  $entry = $rows | Where-Object { $_.ProcessId -eq ${target} } | Select-Object -First 1
  $after = [DateTime]::UtcNow
  $nativeAfter = Get-Process -Id ${target} -ErrorAction SilentlyContinue
  Emit @{kind='query_end';round=$round;afterUtc=$after.ToString('o');queryMs=$duration;count=$rows.Count;cimSeen=($null -ne $entry);target=$entry;getProcessAfter=($null -ne $nativeAfter)}
  if ($null -ne $entry) { break }
  Start-Sleep -Milliseconds 50
}`;
}
async function sample(variant: string, phase: string, options: { readonly index: number; readonly loadPids?: readonly number[] }): Promise<void> {
  const { index, loadPids = [] } = options;
  const bornAt = new Date().toISOString();
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${phase === "cpu_load" ? "120000" : "60000"})`], { stdio: "ignore", windowsHide: true });
  owned.add(child);
  child.once("exit", () => { owned.delete(child); });
  await once(child, "spawn");
  const spawnAt = new Date().toISOString();
  const target = child.pid;
  if (target === undefined) { throw new Error("Spawned child has no PID"); }
  let command = measured(variant, target, loadPids);
  let timeoutMs = phase === "cpu_load" ? 60_000 : 15_000;
  if (phase === "visibility") { command = visibility(variant, target); timeoutMs = 20_000; }
  if (variant === "exact") { command = exact; timeoutMs = 5000; }
  if (variant === "baseline") { command = "[DateTime]::UtcNow.ToString('o')"; }
  const begin = performance.now();
  emit({ kind: "sample_start", variant, phase, index, target, bornAt, spawnAt, timeoutMs });
  try {
    const pending = Promise.withResolvers<SampleResult>();
    {
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- Keep timeout output and the owned ChildProcess handle from the native callback API.
      const shell = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
        let parsed: unknown = null;
        let parseError = false;
        try {
          if (phase === "visibility") { parsed = stdout.trim().split(/\r?\n/u).filter(Boolean).map((line): unknown => JSON.parse(line)); }
          else if (variant === "exact") { const rows: unknown = JSON.parse(stdout); const entries: unknown[] = Array.isArray(rows) ? rows : [rows]; parsed = { count: entries.length, targetSeen: entries.some((entry) => asRecord(entry)?.ProcessId === target), target: entries.find((entry) => asRecord(entry)?.ProcessId === target) ?? null }; }
          else if (variant !== "baseline") { parsed = JSON.parse(stdout); }
        } catch { parseError = true; }
        pending.resolve({ variant, phase, index, target, bornAt, spawnAt, timeoutMs, totalMs: performance.now() - begin, ok: error === null && !parseError, error: error === null ? null : { code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? false }, parseError, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), parsed });
      });
      owned.add(shell);
      shell.once("exit", () => { owned.delete(shell); });
      shell.on("exit", (code, signal) => { emit({ kind: "shell_exit", variant, phase, index, code, signal, totalMs: performance.now() - begin }); });
      if (phase === "visibility") {
        let partial = "";
        shell.stdout?.on("data", (chunk: Buffer | string) => {
          partial += String(chunk);
          let boundary = partial.indexOf("\n");
          while (boundary >= 0) {
            const line = partial.slice(0, boundary).trim(); partial = partial.slice(boundary + 1);
            try { emit({ kind: "visibility", variant, index, observation: parse(line) }); } catch { /* Final parser retains parse failure. */ }
            boundary = partial.indexOf("\n");
          }
        });
      }
    }
    const result = await pending.promise;
    results.push(result);
    emit({ kind: "sample_end", ...result });
    persist(true);
  } finally {
    child.kill();
  }
}
async function withCpuLoad(): Promise<void> {
  const cores = availableParallelism();
  const workerCount = Math.min(cores, 16);
  const workers: ChildProcess[] = [];
  try {
    const pids = await Promise.all(Array.from({ length: workerCount }, async (): Promise<number> => {
      // Self-expiry also bounds a worker if the observer is forcibly stopped.
      const child = spawn(process.execPath, ["-e", "const end = Date.now() + 450000; process.send('ready'); process.disconnect(); while (Date.now() < end) { Math.random(); }"], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
      workers.push(child);
      owned.add(child);
      child.once("exit", () => { owned.delete(child); });
      const readyEvent: unknown[] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
      const [ready] = readyEvent;
      if (ready !== "ready" || child.pid === undefined) { throw new Error("Load worker did not report readiness"); }
      return child.pid;
    }));
    emit({ kind: "load_ready", cores, workerCount, pids, queryTimeoutMs: 60_000 });
    await delay(2000);
    for (let index = 0; index < 3; index++) {
      for (const variant of index % 2 === 0 ? ["full", "projected"] : ["projected", "full"]) {
        if (workers.some((child) => child.exitCode !== null || child.signalCode !== null)) { throw new Error("Load worker exited before measurement completed"); }
        await sample(variant, "cpu_load", { index, loadPids: pids });
      }
    }
  } finally {
    for (const child of workers) { child.kill(); }
    emit({ kind: "load_stopped", workerCount: workers.length });
  }
}
try {
  // Counterbalance order. Each measured query has six sequential and six
  // paired samples; paired shells supply modest, explicitly bounded load.
  for (let index = 0; index < 4; index++) { await sample("baseline", "sequential", { index }); }
  for (let index = 0; index < 4; index++) { await sample("exact", "native_5s", { index }); }
  for (let index = 0; index < 6; index++) {
    for (const variant of index % 2 === 0 ? ["full", "projected"] : ["projected", "full"]) { await sample(variant, "sequential", { index }); }
  }
  for (let index = 0; index < 6; index++) { await Promise.all([sample("full", "paired", { index }), sample("projected", "paired", { index })]); }
  for (let index = 0; index < 2; index++) { await sample("full", "visibility", { index }); await sample("projected", "visibility", { index }); }
  await withCpuLoad();
  persist(false);
  emit({ kind: "complete", summary: summary() });
} finally {
  clearTimeout(deadline);
  for (const child of owned) { try { child.kill(); } catch { /* Already gone. */ } }
}
