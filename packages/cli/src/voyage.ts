import { closeSync, openSync, writeSync } from "node:fs";
import type { SessionEvent } from "@botiverse/oar";

// The oar-voyage/1 JSONL format: one JSON object per line, discriminated by
// `kind`. Line 1 is `header`; `submission` marks each human input; `event`
// wraps one raw SessionEvent verbatim (no filtering or re-timestamping);
// `end` is the last line — a log without it is a truncated capture. All
// timestamps are Unix epoch milliseconds on the same clock as `receivedAt`.
// The format is defined and owned by oar; other tools may consume it.

export const VOYAGE_FORMAT = "oar-voyage/1";

export type SubmissionVia = "prompt" | "steer" | "queue";

export interface VoyageHeader {
  readonly runtime: string;
  readonly model?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly recorder: string;
}

export function headerLine(header: VoyageHeader): string {
  return JSON.stringify({
    kind: "header",
    format: VOYAGE_FORMAT,
    runtime: header.runtime,
    ...(header.model === undefined ? {} : { model: header.model }),
    cwd: header.cwd,
    sessionId: header.sessionId,
    startedAt: header.startedAt,
    recorder: header.recorder,
  });
}

export function submissionLine(at: number, via: SubmissionVia, text: string): string {
  return JSON.stringify({ kind: "submission", at, via, text });
}

export function eventLine(event: SessionEvent): string {
  return JSON.stringify({ kind: "event", event });
}

export function endLine(at: number, reason: string): string {
  return JSON.stringify({ kind: "end", at, reason });
}

export interface VoyageRecorder {
  submission(via: SubmissionVia, text: string): void;
  event(event: SessionEvent): void;
  end(reason: string): void;
}

// Lines go through synchronous fd writes so their order — and everything
// written so far — survives a crashing process; `end` closes the file.
export function openVoyage(path: string, header: VoyageHeader): VoyageRecorder {
  const fd = openSync(path, "w");
  const write = (line: string): void => {
    writeSync(fd, `${line}\n`);
  };
  write(headerLine(header));
  return {
    submission(via, text) {
      write(submissionLine(Date.now(), via, text));
    },
    event(event) {
      write(eventLine(event));
    },
    end(reason) {
      write(endLine(Date.now(), reason));
      closeSync(fd);
    },
  };
}
