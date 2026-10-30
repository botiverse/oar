/** Probe-owned process reads: long, measured budgets never change product limits. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { observeProcessTable, type ProcessEntry, type ProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

export const processReadTimeoutMs = 60_000;
let outputFile: string | null = null;
export function recordProcessTableReads(file: string): void { outputFile = file; }

/** Retain structural facts only, including failures; never command output or arguments. */
export function processReadObservation(entry: Record<string, unknown>): void {
  const line = `${JSON.stringify({ kind: "probe_process_read", at: new Date().toISOString(), ...entry })}\n`;
  if (outputFile !== null) { appendFileSync(outputFile, line, { mode: 0o600 }); }
  process.stdout.write(line);
}

export function processReadFailure(error: unknown): Record<string, unknown> {
  const native = asRecord(error);
  return { errorCode: typeof native?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(native.code) ? native.code : null,
    exitCode: typeof native?.status === "number" ? native.status : null,
    signal: typeof native?.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(native.signal) ? native.signal : null };
}

function windowsTable(): { table: ProcessTable; skipped: number; queryMs: number } {
  const command = [
    "$ErrorActionPreference='Stop'", "$readClock=[Diagnostics.Stopwatch]::StartNew()",
    "$readRows=@(Get-CimInstance Win32_Process)", "$queryMs=$readClock.Elapsed.TotalMilliseconds",
    "$identities=@($readRows | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}})",
    "@{queryMs=$queryMs;rows=$identities} | ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const raw: unknown = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", timeout: processReadTimeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }));
  const value = asRecord(raw);
  assert.ok(value && typeof value.queryMs === "number" && Number.isFinite(value.queryMs) && value.queryMs >= 0 && Array.isArray(value.rows), "invalid process table envelope");
  const table = new Map<number, ProcessEntry>(); let skipped = 0;
  for (const item of value.rows) {
    const row = asRecord(item);
    assert.ok(row && typeof row.ProcessId === "number" && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0
      && typeof row.ParentProcessId === "number" && Number.isSafeInteger(row.ParentProcessId) && row.ParentProcessId >= 0, "invalid process identity");
    if (row.Started === undefined || row.Started === null || row.Started === "" || row.ProcessId === 0 || row.ProcessId === 4) { skipped += 1; }
    else {
      assert.ok(typeof row.Started === "string", "invalid process start identity");
      table.set(row.ProcessId, { pid: row.ProcessId, ppid: row.ParentProcessId, pgid: 0, start: row.Started });
    }
  }
  return { table, skipped, queryMs: value.queryMs };
}

function posixTable(): { table: ProcessTable; skipped: number } {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: processReadTimeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const table = new Map<number, ProcessEntry>();
  for (const line of output.split("\n").filter(row => row.trim() !== "")) {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+(?<start>\S.*?)\s*$/u.exec(line)?.groups;
    assert.ok(match, "invalid process identity");
    const pid = Number(match.pid); table.set(pid, { pid, ppid: Number(match.ppid), pgid: Number(match.pgid), start: match.start ?? "" });
  }
  return { table, skipped: 0 };
}

export function checkedProcessTable(label = "process-table", platform: NodeJS.Platform = process.platform): ProcessTable {
  const start = performance.now();
  let source: "procfs" | "windows" | "ps" = "ps";
  if (platform === "linux") { source = "procfs"; } else if (platform === "win32") { source = "windows"; }
  let failureObservation: unknown = null;
  try {
    // procfs has no subprocess deadline. Reuse its structural validation only.
    let result: ReturnType<typeof observeProcessTable> | { table: ProcessTable; skipped: number; queryMs?: number } = { table: new Map(), skipped: 0 };
    if (source === "procfs") { result = observeProcessTable("procfs"); }
    else if (source === "windows") { result = windowsTable(); }
    else { result = posixTable(); }
    if ("ok" in result && !result.ok) { failureObservation = result; throw new Error("procfs read failed"); }
    assert.ok(result.table.has(process.pid), "process table missing observer identity");
    processReadObservation({ label, source, outcome: "completed", timeoutMs: source === "procfs" ? null : processReadTimeoutMs,
      elapsedMs: performance.now() - start, entries: result.table.size, skipped: result.skipped,
      ...("queryMs" in result ? { queryMs: result.queryMs } : {}) });
    return result.table;
  } catch (error) {
    const diagnostic = { label, source, outcome: "failed", timeoutMs: source === "procfs" ? null : processReadTimeoutMs,
      elapsedMs: performance.now() - start, ...processReadFailure(error),
      ...(source === "procfs" ? { observation: failureObservation } : {}) };
    processReadObservation(diagnostic);
    // oxlint-disable-next-line eslint/preserve-caught-error -- Native errors can contain command output; retain only structural diagnostic facts.
    throw new Error(`Probe process table unavailable: ${JSON.stringify(diagnostic)}`, { cause: diagnostic });
  }
}
