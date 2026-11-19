import type { Frame, ResponseBody } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import { manualCompaction, type CompactionOperation, type CompactionSettlement } from "../../shared/manual-compaction.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import { DshCommandError, type DshControl } from "./control.js";

/** The initiating command id belongs to the caller; the compaction id belongs to DSH. */
function operation(kernel: SessionKernel, control: DshControl): CompactionOperation {
  let commandId: string | null = null;
  let reply: ((body: ResponseBody) => void) | null = null;
  let end: Frame | null = null;
  let compactionId: string | null = null;
  return {
    async start(request, respond) {
      commandId = request.id;
      reply = respond;
      try {
        const result = await control.request("compact", { sessionId: kernel.sessionId, commandId }, null);
        if (kernel.unreachable() !== null) { return; }
        respond({ kind: "accepted" });
        kernel.frame({ type: "dsh/compact", native: result, responseTo: commandId, events: [] });
      } catch (error) {
        if (kernel.unreachable() !== null) { return; }
        if (compactionId === null && error instanceof DshCommandError && error.code === "busy") {
          respond({ kind: "rejected", code: "busy", reason: error.message, native: error.native });
          return;
        }
        respond({ kind: "accepted" });
        const native = error instanceof DshCommandError ? error.native : { message: String(error) };
        kernel.frame({ type: "dsh/compact/error", native, responseTo: commandId, events: [] });
      }
    },
    observe(frame): CompactionSettlement | null {
      const { body } = frame;
      const native = asRecord(body.native);
      const data = asRecord(native?.data);
      if (commandId === null) { return null; }
      if (body.responseTo === commandId) {
        if (body.type === "dsh/compact/error") {
          return native?.code === "cancelled" || native?.name === "AbortError" ? { kind: "aborted", frame }
            : { kind: "failed", code: "native_failed", reason: typeof native?.message === "string" ? native.message : "DSH compaction failed", frame };
        }
        if (native?.result === null) { return { kind: "failed", code: "not_compacted", reason: "DSH found no compactable history", frame }; }
        const result = asRecord(native?.result);
        if (end !== null && result?.sourceCommandId === commandId && result.compactionId === compactionId) { return { kind: "completed", frame: end }; }
        return { kind: "unconfirmed", code: "observation_failed", reason: "DSH answered without matching compaction boundaries" };
      }
      if (data?.sourceCommandId !== commandId || typeof data.compactionId !== "string") { return null; }
      if (body.type === "session/event:compaction/start") {
        compactionId = data.compactionId;
        reply?.({ kind: "accepted" });
      } else if (body.type === "session/event:compaction/end" && data.compactionId === compactionId && data.error === undefined) { end = frame; }
      return null;
    },
  };
}

export function dshCompaction(kernel: SessionKernel, control: DshControl, busy: () => boolean): ReturnType<typeof manualCompaction> {
  return manualCompaction(kernel, { busy, busyReason: "DSH compaction requires an idle session with no pending input", settledBy: "native_response", create: () => operation(kernel, control) });
}
