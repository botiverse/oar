import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { processStart, signalFixture, type ProcessIdentity } from "../../../tests/fixtures/process-tree.js";
import { expect, vi, type Assertion } from "vitest";

export interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps lstart`, in the runner's local time. */
  readonly startedAt: string;
  readonly args: string;
}

export function processTable(): Row[] {
  return execFileSync("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,args="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[4] ?? "", args: match[5] ?? "" }];
  });
}

/** Bracket the confirming command/ancestry snapshot with fixture identity reads.
 * Only selected processes need a start-time query. */
export function identifiedProcesses(select: (rows: readonly Row[]) => readonly Row[]): (Row & ProcessIdentity)[] {
  const candidates = select(processTable());
  if (candidates.length === 0) { return []; }
  const starts = new Map(candidates.map(row => [row.pid, processStart(row.pid)]));
  return select(processTable()).flatMap(row => {
    const start = starts.get(row.pid);
    return start !== undefined && processStart(row.pid) === start ? [{ ...row, start }] : [];
  });
}

export function reapMarkedProcesses(markers: readonly string[]): void {
  const matches = identifiedProcesses(rows => rows.filter(row => markers.some(marker => row.args.includes(marker))));
  for (const match of matches) { signalFixture(match); }
}

/** Use one snapshot for both the assertion and its failure details; only include this test's marker matches. */
export function expectRunning(marker: string): Assertion<number[]> {
  const matches = processTable().filter((row) => row.args.includes(marker));
  return expect(matches.map((row) => row.pid), JSON.stringify({ marker, processes: matches }, null, 2));
}

/** A yielded exec can still be in shell startup. The fixture itself appends its PID once it starts. */
export async function expectStarted(file: string): Promise<void> {
  await vi.waitFor(async () => {
    const content = await readFile(file, "utf8");
    const pids = content.trim().split("\n");
    expect(pids, "fixture must start exactly once").toHaveLength(1);
    expect(pids[0]).toMatch(/^\d+$/u);
  }, { timeout: 10_000, interval: 50 });
}

