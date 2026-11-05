import { expect, vi } from "vitest";
import type { ControlResult, Session } from "../../../packages/oar/src/contracts/session.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";

/** The provider request and app-server notifications arrive on independent transports. */
export async function abortStartedCodexCompaction(session: Session, afterSeq: number): Promise<ControlResult> {
  await vi.waitFor(() => {
    const records = session.records().filter((record) => record.seq > afterSeq);
    expect(records.some((record) => {
      if (record.kind !== "frame" || record.sessionId !== session.id || record.body.type !== "item/started") { return false; }
      const native = asRecord(record.body.native);
      const item = asRecord(native?.item);
      return native?.threadId === session.id && typeof native.turnId === "string"
        && item?.type === "contextCompaction" && typeof item.id === "string";
    }), JSON.stringify({ status: session.status().value, records })).toBe(true);
  }, { timeout: 30_000 });
  return session.abort();
}
