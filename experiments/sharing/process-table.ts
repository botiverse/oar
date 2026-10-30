/** Keep an unreadable product process table visible in experiment evidence. */
import { spawnSync } from "node:child_process";
import { readProcessTable, type ProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

function captured(value: unknown): string { return typeof value === "string" ? value : ""; }

function followupWindowsRead(): Record<string, unknown> {
  // This is a separate observation, not the reason for the original failure.
  // Match the product reader's command and deadline, but keep structural facts.
  const start = performance.now();
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const diagnostic: Record<string, unknown> = { elapsedMs: performance.now() - start, exitCode: result.status, signal: result.signal,
    errorCode: result.error && "code" in result.error ? result.error.code : null,
    stdoutBytes: Buffer.byteLength(captured(result.stdout)), stderrBytes: Buffer.byteLength(captured(result.stderr)) };
  try {
    const value: unknown = JSON.parse(captured(result.stdout));
    const entries = (Array.isArray(value) ? value : [value]).map((row: unknown) => asRecord(row));
    diagnostic.rows = entries.length;
    diagnostic.selfPresent = entries.some((entry) => entry?.ProcessId === process.pid);
    diagnostic.selfHasCreationTime = entries.some((entry) => entry?.ProcessId === process.pid && typeof entry.Started === "string" && entry.Started.length > 0);
  } catch { diagnostic.parseFailed = true; }
  return diagnostic;
}

export function checkedProcessTable(): ProcessTable {
  const start = performance.now();
  const table = readProcessTable();
  if (table.has(process.pid)) { return table; }
  const diagnostic = { kind: "process_table_unavailable", platform: process.platform,
    elapsedMs: performance.now() - start, entries: table.size, selfPresent: false,
    ...(process.platform === "win32" ? { followup: followupWindowsRead() } : {}),
  };
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  // Do not substitute the follow-up or retry the measurement into a pass.
  throw new Error(`process table unavailable: ${JSON.stringify(diagnostic)}`);
}
