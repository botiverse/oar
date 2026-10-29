/** Process identity, RSS and CPU only. No command line, environment or open files. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { readProcessTable, descendantsOf, type ProcessEntry } from "../../packages/oar/src/shared/executable/process-tree.js";

interface Reading { readonly identity: ProcessEntry; readonly rss: number; readonly cpuMs: number }

export function rootsSince(before: ReadonlyMap<number, ProcessEntry>): ProcessEntry[] {
  const after = readProcessTable();
  assert.ok(after.has(process.pid), "process table unavailable");
  return [...after.values()].filter((entry) => {
    if (entry.ppid !== process.pid || before.get(entry.pid)?.start === entry.start) { return false; }
    // A Windows process-table reader can appear in its own snapshot, then exit.
    try { process.kill(entry.pid, 0); return true; } catch { return false; }
  });
}

function nativeReadings(entries: readonly ProcessEntry[]): Reading[] {
  if (process.platform === "linux") {
    const page = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }));
    const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
    return entries.flatMap((identity) => {
      let stat = "";
      try { stat = readFileSync(`/proc/${String(identity.pid)}/stat`, "utf8"); } catch { return []; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] === identity.start ? [{ identity, rss: Number(fields[21]) * page,
        cpuMs: (Number(fields[11]) + Number(fields[12])) * 1000 / ticks }] : [];
    });
  }
  const pids = entries.map((entry) => entry.pid).join(",");
  if (pids.length === 0) { return []; }
  if (process.platform === "win32") {
    const raw: unknown = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Process -Id ${pids} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,@{Name='CpuMs';Expression={$_.TotalProcessorTime.TotalMilliseconds}} | ConvertTo-Json -Compress`],
    { encoding: "utf8", timeout: 10_000 }));
    return (Array.isArray(raw) ? raw : [raw]).flatMap((value: unknown) => {
      const row = asRecord(value); const identity = entries.find((entry) => entry.pid === row?.Id);
      assert.ok(identity && typeof row?.WorkingSet64 === "number" && typeof row.CpuMs === "number");
      return [{ identity, rss: row.WorkingSet64, cpuMs: row.CpuMs }];
    });
  }
  const output = execFileSync("ps", ["-p", pids, "-o", "pid=,rss=,time="], { encoding: "utf8", timeout: 10_000 });
  return output.trim().split("\n").map((line) => {
    const [pid, rss, time = ""] = line.trim().split(/\s+/u);
    const identity = entries.find((entry) => entry.pid === Number(pid)); assert.ok(identity);
    const parts = time.split(":").map(Number);
    const seconds = parts.reduce((sum, part) => sum * 60 + part, 0); assert.ok(Number.isFinite(seconds));
    return { identity, rss: Number(rss) * 1024, cpuMs: seconds * 1000 };
  });
}

function read(roots: readonly ProcessEntry[]): { at: number; rows: Reading[] } {
  const table = readProcessTable(); assert.ok(table.has(process.pid), "process table unavailable");
  const members = new Map<number, ProcessEntry>();
  for (const root of roots) {
    if (table.get(root.pid)?.start === root.start) {
      members.set(root.pid, root);
      for (const entry of descendantsOf(table, root.pid)) { members.set(entry.pid, entry); }
    }
  }
  return { at: performance.now(), rows: nativeReadings([...members.values()]) };
}

export async function resourceSample(roots: readonly ProcessEntry[], windowMs = 5000): Promise<Record<string, unknown>> {
  const before = read(roots); await delay(windowMs); const after = read(roots);
  let cpuMs = 0;
  for (const row of after.rows) {
    const previous = before.rows.find((entry) => entry.identity.pid === row.identity.pid && entry.identity.start === row.identity.start);
    // A newly observed process contributes its accumulated time. Exited processes are a lower bound.
    cpuMs += row.cpuMs - (previous?.cpuMs ?? 0);
  }
  const exited = before.rows.filter((row) => !after.rows.some((entry) => entry.identity.pid === row.identity.pid && entry.identity.start === row.identity.start));
  return { elapsedMs: after.at - before.at, cpuPercentOneCore: cpuMs / (after.at - before.at) * 100,
    cpuIsLowerBound: exited.length > 0, exitedDuringWindow: exited.length,
    rssBytes: after.rows.reduce((sum, row) => sum + row.rss, 0), processes: after.rows.length };
}
