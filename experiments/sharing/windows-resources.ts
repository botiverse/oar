/** Probe-only resource reads. Exited PIDs are absent, not a failed command. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { asRecord } from "../../packages/oar/src/shared/json.js";

export interface WindowsReading { readonly pid: number; readonly rss: number; readonly cpuMs: number }

export function windowsReadings(pids: readonly number[]): WindowsReading[] {
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0), "positive integer PIDs required");
  if (pids.length === 0) { return []; }
  // Enumerate first and filter afterwards: Get-Process -Id reports a nonzero
  // exit when one requested PID disappears, even if the other rows are valid.
  // Genuine enumeration/property errors still fail the complete reading.
  const command = `$ErrorActionPreference = 'Stop'; $wanted = @(${pids.join(",")}); $rows = @(Get-Process | Where-Object { $_.Id -in $wanted } | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Rss = $_.WorkingSet64; CpuMs = $_.TotalProcessorTime.TotalMilliseconds } }); ConvertTo-Json -InputObject $rows -Compress; exit 0`;
  const raw: unknown = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.ok(Array.isArray(raw), "resource reader must return an array, including when empty");
  return raw.map((value: unknown) => {
    const row = asRecord(value);
    assert.ok(row && typeof row.Id === "number" && pids.includes(row.Id)
      && typeof row.Rss === "number" && Number.isFinite(row.Rss) && row.Rss >= 0
      && typeof row.CpuMs === "number" && Number.isFinite(row.CpuMs) && row.CpuMs >= 0, "invalid process resource row");
    return { pid: row.Id, rss: row.Rss, cpuMs: row.CpuMs };
  });
}
