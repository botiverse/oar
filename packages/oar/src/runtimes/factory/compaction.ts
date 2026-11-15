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
 * "Nothing to compact". The RPC id is the OAR compact request id, so
 * `session_compacted` seen while it is pending belongs to it.
 */
export function factoryCompaction(kernel: SessionKernel, client: DroidClient, sessionId: string, pending: (requestId: string | null) => void): CompactionOperation {
  let requestId: string | null = null;
  let compacted: Frame | null = null;
  return {
    async start(request, reply) {
      requestId = request.id;
      pending(request.id);
      try {
        const answer = client.request("droid.compact_session", {}, undefined, request.id);
        reply({ kind: "accepted" });
        // The answer's frame settles the operation (observe below sees it first).
        const frame = kernel.frame({ type: "droid.compact_session", native: await answer, responseTo: request.id, events: [] });
        return settle(frame) ?? { kind: "unconfirmed", code: "observation_failed", reason: "droid's compact_session answer was not recorded" };
      } catch (error) {
        const native = asRecord(asRecord(error instanceof Error ? error.cause : null)?.native);
        if (native === null || kernel.unreachable() !== null) { throw error; }
        kernel.frame({ type: "droid.compact_session/error", native, responseTo: request.id, events: [] });
        return { kind: "rejected", code: "runtime_refused", reason: typeof native.message === "string" ? native.message : "droid refused compact_session" };
      } finally { pending(null); }
    },
    observe: (frame) => settle(frame),
  };
  function settle(frame: Frame): CompactionSettlement | null {
    if (requestId === null) { return null; }
    const ended = frame.body.events.find(event => event.kind === "compaction_ended");
    if (ended?.kind === "compaction_ended" && ended.requestId === requestId) { compacted = frame; return null; }
    if (frame.body.type !== "droid.compact_session" || frame.body.responseTo !== requestId) { return null; }
    const answer = asRecord(frame.body.native);
    if (typeof answer?.newSessionId === "string" && answer.newSessionId !== sessionId) {
      return { kind: "failed", code: "native_failed", reason: `droid moved the conversation to session ${answer.newSessionId}; this session's id no longer names it`, frame };
    }
    if (compacted !== null) { return { kind: "completed", frame: compacted }; }
    return asNumber(answer?.removedCount) === 0
      ? { kind: "failed", code: "not_compacted", reason: "droid removed no messages", frame }
      : { kind: "unconfirmed", code: "observation_failed", reason: "droid answered compact_session without reporting session_compacted" };
  }
}
