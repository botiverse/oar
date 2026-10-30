/** Identify the actual executable within an owned launch tree, never its first child. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import path from "node:path";
import type { ProcessEntry, ProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { checkedProcessTable, processReadTimeoutMs } from "./process-table.js";

export interface NativeProcessSelection { readonly root: ProcessEntry; readonly selected: ProcessEntry; readonly candidates: readonly { identity: ProcessEntry; executable: string | null }[] }

function executable(pid: number): string | null {
  try {
    if (process.platform === "linux") { return path.basename(readlinkSync(`/proc/${String(pid)}/exe`)); }
    if (process.platform === "win32") {
      const raw: unknown = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; Get-Process | Where-Object { $_.Id -eq ${String(pid)} } | Select-Object ProcessName | ConvertTo-Json -Compress`],
      { encoding: "utf8", timeout: processReadTimeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
      const name = asRecord(raw)?.ProcessName; return typeof name === "string" ? name : null;
    }
    return path.basename(execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: processReadTimeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch { return null; }
}

export function selectNativeProcess(root: ProcessEntry, table: ProcessTable, images: { readonly names: ReadonlyMap<number, string | null>; readonly expected: string }): NativeProcessSelection {
  const { names, expected } = images;
  assert.equal(table.get(root.pid)?.start, root.start, "launch PID identity changed before native selection");
  const candidates = [root, ...[...table.values()].filter(entry => entry.ppid === root.pid)]
    .map(identity => ({ identity, executable: names.get(identity.pid) ?? null }));
  const matches = candidates.filter(entry => entry.executable?.toLowerCase().replace(/\.exe$/u, "") === expected.toLowerCase());
  assert.equal(matches.length, 1, "expected exactly one identified native executable in the launch root or its direct children");
  const selected = matches[0]?.identity; assert.ok(selected);
  return { root, selected, candidates };
}

export function identifyNativeProcess(root: ProcessEntry, expected: string): NativeProcessSelection {
  const table = checkedProcessTable("identify-native-process");
  const candidates = [root, ...[...table.values()].filter(entry => entry.ppid === root.pid)];
  const names = new Map(candidates.map(entry => [entry.pid, executable(entry.pid)]));
  const selection = selectNativeProcess(root, table, { names, expected });
  // Image inspection may take time. Do not retain a PID whose identity changed meanwhile.
  const current = checkedProcessTable("validate-native-process");
  assert.equal(current.get(selection.selected.pid)?.start, selection.selected.start, "native identity changed during selection");
  return selection;
}
