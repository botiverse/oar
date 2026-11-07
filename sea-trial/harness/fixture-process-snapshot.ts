import { execFile, type ChildProcess } from "node:child_process";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const timeoutMs = 2000;
const maxBytes = 512 * 1024;
const maxRows = 1024;
const command = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; "
  + "$rows=@(Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId "
  + "| Select-Object -First 1025 Name,ProcessId,ParentProcessId); ConvertTo-Json -InputObject $rows -Compress";

interface ProcessRow { readonly name: string; readonly pid: number; readonly parentPid: number }
type Snapshot =
  | { readonly outcome: "captured"; readonly processes: readonly ProcessRow[]; readonly truncated: boolean }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "failed"; readonly reason: "spawn" | "query" | "output_limit" | "invalid_output" };

function parse(stdout: string): Snapshot {
  try {
    const value: unknown = JSON.parse(stdout);
    const rows = Array.isArray(value) ? value : [value];
    const processes: ProcessRow[] = [];
    for (const row of rows.slice(0, maxRows)) {
      const item = asRecord(row);
      if (item === null || typeof item.Name !== "string" || item.Name.length > 256
        || typeof item.ProcessId !== "number" || !Number.isSafeInteger(item.ProcessId) || item.ProcessId < 0
        || typeof item.ParentProcessId !== "number" || !Number.isSafeInteger(item.ParentProcessId) || item.ParentProcessId < 0) {
        return { outcome: "failed", reason: "invalid_output" };
      }
      processes.push({ name: item.Name, pid: item.ProcessId, parentPid: item.ParentProcessId });
    }
    return { outcome: "captured", processes, truncated: rows.length > maxRows };
  } catch { return { outcome: "failed", reason: "invalid_output" }; }
}

function release(child: ChildProcess | null): void {
  // Only this diagnostic's PowerShell process is stopped, never a sampled process.
  try { child?.kill(); } catch { /* Observation failure cannot affect the test. */ }
  try { child?.stdin?.destroy(); } catch { /* Drop this observer's pipe. */ }
  try { child?.stdout?.destroy(); } catch { /* Drop this observer's pipe. */ }
  try { child?.stderr?.destroy(); } catch { /* Drop this observer's pipe. */ }
  try { child?.unref(); } catch { /* Do not retain the observer. */ }
}

/** One bounded observation, not proof of directory ownership or process cleanup. */
// oxlint-disable-next-line typescript/promise-function-async -- Bridge a callback and an independent timer without an extra async wrapper.
export function snapshotFixtureProcesses(): Promise<Snapshot> {
  return new Promise(resolve => {
    let child: ChildProcess | null = null;
    let settled = false;
    const finish = (result: Snapshot): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Do not depend on execFile's callback: a killed process can retain open pipes.
    const timer = setTimeout(() => { finish({ outcome: "timeout" }); release(child); }, timeoutMs);
    try {
      child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true, maxBuffer: maxBytes }, (error, stdout) => {
          if (settled) { return; }
          finish(error === null ? parse(stdout) : { outcome: "failed", reason: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output_limit" : "query" });
        });
      child.unref();
    } catch { finish({ outcome: "failed", reason: "spawn" }); release(child); }
  });
}
