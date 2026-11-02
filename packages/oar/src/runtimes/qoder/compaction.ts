import type { Frame, RequestRecord, ResponseBody } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import type { CompactionOperation } from "../../shared/manual-compaction.js";

/** Qoder intercepts builtin /compact before custom commands. Its result has no input UUID. */
export function qoderCompaction(send: (request: RequestRecord) => ResponseBody): CompactionOperation {
  let id: string | null = null;
  let started = false;
  let boundary: Frame | null = null;
  let result: Frame | null = null;
  return {
    start(request, reply) { id = request.id; reply(send(request)); },
    observe(frame) {
      const native = asRecord(frame.body.native);
      if (id === null || native === null) { return null; }
      if (native.type === "command_lifecycle" && native.command_uuid === id && native.state === "started") { started = true; }
      if (started && native.type === "result") { result = frame; }
      if (started && frame.body.events.some((event) => event.kind === "compaction_ended" && event.trigger === "manual" && event.outcome === "completed")) { boundary = frame; }
      if (native.type !== "command_lifecycle" || native.command_uuid !== id || (native.state !== "completed" && native.state !== "cancelled")) { return null; }
      // Cancellation can race after a real compact_boundary. The completed compaction remains a fact.
      if (boundary !== null) { return { kind: "completed", frame: boundary }; }
      if (native.state === "cancelled") { return { kind: "aborted", frame }; }
      if (result !== null && asRecord(result.body.native)?.is_error === true) {
        return { kind: "failed", code: "native_failed", reason: "Qoder reported a compact command failure", frame: result };
      }
      return { kind: "failed", code: "not_compacted", reason: "Qoder completed the command without its native manual compact_boundary", frame };
    },
  };
}
