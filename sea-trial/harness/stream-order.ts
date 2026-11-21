import assert from "node:assert/strict";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";

/**
 * Record-stream contract: `turn_ended` is the last event of its turn, so
 * within any frame no `usage` may follow `turn_ended` unless a `turn_active`
 * opens a subsequent turn between them.
 */
export function assertNoUsageAfterTurnEnded(records: readonly RawEvent[]): void {
  for (const record of records) {
    if (record.kind === "frame") {
      let closed = false;
      for (const event of record.body.events) {
        if (event.kind === "turn_ended") {
          closed = true;
        } else if (event.kind === "turn_active") {
          closed = false;
        } else if (event.kind === "usage" && closed) {
          assert.fail(
            `frame seq=${String(record.seq)} (${record.body.type}) emitted usage after turn_ended without an intervening turn_active: [${record.body.events.map((item) => item.kind).join(", ")}]`,
          );
        }
      }
    }
  }
}
