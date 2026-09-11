import { closeSync, openSync, writeSync } from "node:fs";
import type { SessionRecord } from "./contracts/session.js";

// The oar-voyage/2 JSONL format: one JSON object per line, discriminated by
// `kind`. Line 1 is `header`; `record` wraps one SessionRecord verbatim (no
// filtering or re-timestamping — human inputs are in the stream already, as
// request records); `end` is the last line — a log without it is a truncated
// capture. All timestamps are Unix epoch milliseconds on the same clock as
// `receivedAt`. The format is defined and owned by oar; other tools may
// consume it. oar-voyage/1 (v1 events + separate submission lines) is no
// longer written.

export const VOYAGE_FORMAT = "oar-voyage/2";

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

export function recordLine(record: SessionRecord): string {
  return JSON.stringify({ kind: "record", record });
}

export function endLine(at: number, reason: string): string {
  return JSON.stringify({ kind: "end", at, reason });
}

export interface VoyageRecorder {
  record(record: SessionRecord): void;
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
    record(record) {
      write(recordLine(record));
    },
    end(reason) {
      write(endLine(Date.now(), reason));
      closeSync(fd);
    },
  };
}
