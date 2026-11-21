import assert from "node:assert/strict";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";

/**
 * Record-stream contract: `turn_ended` is the last event of its turn, so
 * within any frame, after `turn_ended`, the next event must be `turn_active`
 * (opening a subsequent turn) or the frame must end.
 */
export function assertTurnEndedLast(records: readonly RawEvent[]): void {
  for (const record of records) {
    if (record.kind === "frame") {
      let closed = false;
      for (const event of record.body.events) {
        if (closed && event.kind === "turn_active") {
          closed = false;
        } else if (closed) {
          assert.fail(
            `frame seq=${String(record.seq)} (${record.body.type}) emitted ${event.kind} after turn_ended without an intervening turn_active: [${record.body.events.map((item) => item.kind).join(", ")}]`,
          );
        } else if (event.kind === "turn_ended") {
          closed = true;
        }
      }
    }
  }
}
