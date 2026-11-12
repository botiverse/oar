import { execFileSync } from "node:child_process";
import { expect, type Assertion } from "vitest";

interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps lstart`, in the runner's local time. */
  readonly startedAt: string;
  readonly args: string;
}

export function processTable(): Row[] {
  return execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,args="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[4] ?? "", args: match[5] ?? "" }];
  });
}

/** Use one snapshot for both the assertion and its failure details; only include this test's marker matches. */
export function expectRunning(marker: string): Assertion<number[]> {
  const matches = processTable().filter((row) => row.args.includes(marker));
  return expect(matches.map((row) => row.pid), JSON.stringify({ marker, processes: matches }, null, 2));
}

