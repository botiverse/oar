import type { Frame } from "../../contracts/session.js";
import type { CompactionOperation, CompactionSettlement } from "../../shared/manual-compaction.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import { asNumber, asRecord } from "../../shared/json.js";
import type { DroidClient } from "./client.js";

/*
 * `droid.compact_session {}` (droid 1.12.1, probed 2026-11-15): droid
 * summarizes the conversation in the same session (`newSessionId` equals the
 * current id), reports `session_compacted` and then answers `{ newSessionId,
 * removedCount }`. During a turn it refuses with -32602 "Wait for the current
 * turn to finish before compacting."; on an empty conversation with -32602
 * "Nothing to compact". Only the identified RPC answer belongs to the request.
 */
export function factoryCompaction(
  kernel: SessionKernel,
  client: DroidClient,
  sessionId: string,
  recordConfirmed?: (record: () => void) => Promise<void>,
): CompactionOperation {
  let requestId: string | null = null;
  let settled: Promise<void> = Promise.resolve();
  return {
    async start(request, reply) {
      requestId = request.id;
      const answer = client.request("droid.compact_session", {}, (outcome) => {
        if (outcome.kind === "exited") { return; }
        const type = outcome.kind === "result" ? "droid.compact_session" : "droid.compact_session/error";
        let recorded = false;
        const record = (): void => {
          if (recorded) { return; }
          recorded = true;
          kernel.frame({ type, native: outcome.native, responseTo: request.id, events: [] });
        };
        const result = outcome.kind === "result" ? asRecord(outcome.result) : null;
        const removed = asNumber(result?.removedCount);
        const confirmed = result?.newSessionId === sessionId && removed !== null && Number.isSafeInteger(removed) && removed > 0;
        if (!confirmed) {
          client.mark(record);
          return;
        }
        // Refresh context stats before recording completion so session.contextUsage()
        // reflects compaction as soon as compact() resolves.
        settled = (async (): Promise<void> => {
          try { if (recordConfirmed !== undefined) { await recordConfirmed(record); } } finally { record(); }
        })();
      }, request.id);
      reply({ kind: "accepted" });
      try { await answer; } finally { await settled; }
    },
    observe(frame: Frame): CompactionSettlement | null {
      if (requestId === null || frame.body.responseTo !== requestId) { return null; }
      const native = asRecord(frame.body.native);
      if (frame.body.type === "droid.compact_session/error") {
        const message = asRecord(native?.error)?.message;
        return { kind: "rejected", code: "runtime_refused", reason: typeof message === "string" ? message : "droid refused compact_session" };
      }
      if (frame.body.type !== "droid.compact_session") { return null; }
      const answer = asRecord(native?.result);
      const removed = asNumber(answer?.removedCount);
      if (typeof answer?.newSessionId === "string" && answer.newSessionId !== sessionId) {
        return { kind: "failed", code: "native_failed", reason: "droid moved the conversation to another session", frame };
      }
      if (removed === 0) { return { kind: "failed", code: "not_compacted", reason: "droid removed no messages", frame }; }
      if (answer?.newSessionId === sessionId && removed !== null && Number.isSafeInteger(removed) && removed > 0) { return { kind: "completed", frame }; }
      return { kind: "unconfirmed", code: "observation_failed", reason: "droid's answer did not confirm removal in this session" };
    },
  };
}
