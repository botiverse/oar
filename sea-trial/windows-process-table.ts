/** Test and evidence preparation only. Product readers keep their own limits. */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { asRecord } from "../packages/oar/src/shared/json.js";

const timeoutMs = 60_000;
function captured(value: unknown): string { return typeof value === "string" ? value : ""; }

export function prepareWindowsProcessTable(outputFile: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") { return; }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$preparationClock = [Diagnostics.Stopwatch]::StartNew()",
    "$preparationRows = @(Get-CimInstance Win32_Process)",
    "$preparationMs = $preparationClock.Elapsed.TotalMilliseconds",
    `$preparationHost = $preparationRows | Where-Object { $_.ProcessId -eq ${process.pid} } | Select-Object -First 1`,
    "@{queryMs=$preparationMs;count=$preparationRows.Count;selfPresent=($null -ne $preparationHost);selfHasCreationTime=($null -ne $preparationHost.CreationDate)} | ConvertTo-Json -Compress",
  ].join("; ");
  const started = performance.now();
  const at = new Date().toISOString();
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const diagnostic: Record<string, unknown> = {
    kind: "windows_process_table_preparation", at, timeoutMs,
    elapsedMs: performance.now() - started,
    exitCode: result.status, signal: result.signal,
    errorCode: result.error && "code" in result.error ? result.error.code : null,
    error: result.error?.message ?? null,
    stderr: captured(result.stderr).slice(-1024),
    outcome: "failed",
  };
  if (result.error === undefined && result.status === 0 && result.signal === null) {
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      const value = asRecord(parsed);
      if (value !== null && typeof value.queryMs === "number" && Number.isFinite(value.queryMs) && value.queryMs >= 0
        && typeof value.count === "number" && Number.isInteger(value.count) && value.count > 0
        && value.selfPresent === true && value.selfHasCreationTime === true) {
        diagnostic.outcome = "completed";
        diagnostic.queryMs = value.queryMs;
        diagnostic.processes = value.count;
      } else { diagnostic.error = "CIM response did not confirm the observer's process identity"; }
    } catch { diagnostic.error = "CIM response was not valid JSON"; }
  }
  mkdirSync(path.dirname(outputFile), { recursive: true });
  const line = `${JSON.stringify(diagnostic)}\n`;
  appendFileSync(outputFile, line, { mode: 0o600 });
  process.stdout.write(line);
  if (diagnostic.outcome !== "completed") {
    throw new Error(`Windows process-table preparation failed: ${JSON.stringify(diagnostic)}`);
  }
}
