/** Structural evidence for the native lifecycle test, captured before fixture reclamation. */
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { checkedProcessTable } from "../../../experiments/sharing/process-table.js";
import { descendantsOf, killEntries, type ProcessEntry } from "../../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";

export function cleanupObserver(home: string): { observations: unknown[]; sample(stage: string): Promise<void>; reclaim(): void } {
  const owned = new Map<number, ProcessEntry>();
  const observations: unknown[] = [];
  return {
    observations,
    async sample(stage: string): Promise<void> {
      const table = checkedProcessTable(`opencode-${stage}`);
      const current = descendantsOf(table, process.pid);
      for (const entry of current) { owned.set(entry.pid, entry); }
      const retained = [...owned.values()].flatMap(entry => {
        const currentEntry = table.get(entry.pid); return currentEntry?.start === entry.start ? [currentEntry] : [];
      });
      const toolFile = await readFile(path.join(home, "A.json"), "utf8").catch(() => "null");
      const childFile = await readFile(path.join(home, "A-child.json"), "utf8").catch(() => "null");
      const tool = asRecord(JSON.parse(toolFile)); const child = asRecord(JSON.parse(childFile));
      let windows: unknown = null;
      if (process.platform === "win32") {
        // CIM does not expose cwd. Tool cwd below is self-reported, never inferred from its command line.
        const ids = retained.map(entry => entry.pid).join(",");
        const script = `$ErrorActionPreference='Stop'; $wanted=@(${ids}); @(Get-CimInstance Win32_Process | Where-Object { $wanted -contains $_.ProcessId } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name='Started';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Depth 3 -Compress`;
        // oxlint-disable-next-line typescript/strict-void-return -- Node execFile has its own promisify overload while also returning a ChildProcess to callback callers.
        const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
        windows = result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
      }
      const processes = await Promise.all(retained.map(async entry => {
        const row = { pid: entry.pid, ppid: entry.ppid, start: entry.start };
        if (process.platform !== "linux") { return row; }
        const cwd = await readlink(`/proc/${entry.pid}/cwd`).catch(() => null);
        const executable = await readlink(`/proc/${entry.pid}/exe`).catch(() => null);
        return { pid: row.pid, ppid: row.ppid, start: row.start, cwd, executable };
      }));
      const observation = { stage, at: new Date().toISOString(), processes, windows, tool, child };
      observations.push(observation); process.stdout.write(`${JSON.stringify({ kind: "opencode_cleanup", ...observation })}\n`);
    },
    reclaim(): void { killEntries([...owned.values()], checkedProcessTable("opencode-fixture-reclaim")); },
  };
}
