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
export function factoryCompaction(kernel: SessionKernel, client: DroidClient, sessionId: string): CompactionOperation {
  let requestId: string | null = null;
  return {
    async start(request, reply) {
      requestId = request.id;
      const answer = client.request("droid.compact_session", {}, (outcome) => {
        if (outcome.kind === "exited") { return; }
        client.mark(() => { kernel.frame({ type: outcome.kind === "result" ? "droid.compact_session" : "droid.compact_session/error",
          native: outcome.native, responseTo: request.id, events: [] }); });
      }, request.id);
      reply({ kind: "accepted" });
      await answer;
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
