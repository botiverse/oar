import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run/windows-dispose-timing");
export const nativeFile = path.join(directory, "powershell-stages.tsv");
let round = 0;
let query = 0;
let request = 0;
export function startRound(value: number): void { round = value; }
export function nextQuery(): number { return ++query; }
export function nextRequest(): number { return ++request; }
export function timing(stage: string, values: Readonly<Record<string, unknown>> = {}): void {
  mkdirSync(directory, { recursive: true });
  const line = `${JSON.stringify({ at: Date.now(), monotonicMs: performance.now(), round, stage, ...values })}\n`;
  appendFileSync(path.join(directory, "timing.jsonl"), line);
  process.stdout.write(line);
}

/** Side-file timestamps only; the original CIM output and parsing stay intact. */
export function timedCommand(command: string, args: readonly string[], id: number): readonly string[] {
  if (command !== "powershell.exe") { return args; }
  const script = args.at(-1);
  if (script === undefined || !script.includes("Get-CimInstance Win32_Process | Select-Object")) { throw new Error("Unexpected process-table command"); }
  const file = nativeFile.replaceAll("'", "''");
  const mark = (stage: string): string => `[IO.File]::AppendAllText('${file}', '${String(id)}\t${stage}\t' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [Environment]::NewLine)`;
  const prefix = `$ErrorActionPreference = 'Stop'; ${mark("command_enter")}; ${mark("query_start")}; $oarTimingRows = @(Get-CimInstance Win32_Process); ${mark("query_end")}; `;
  return [...args.slice(0, -1), `${prefix}${script.replace("Get-CimInstance Win32_Process", "$oarTimingRows")}; ${mark("command_done")}`];
}
