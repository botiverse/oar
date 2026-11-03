import { RequestError } from "@agentclientprotocol/sdk";
import type { AcpSessionProfile } from "../../shared/acp/profile.js";
import { withAcpDeadline } from "../../shared/acp/process.js";
import { acpErrorNative } from "../../shared/acp/projection.js";
import { asRecord } from "../../shared/json.js";

/** The dedicated RPC response is correlated by the SDK. Notifications alone prove no request ownership. */
export const grokCompaction: NonNullable<AcpSessionProfile["compaction"]> = (kernel, runtime) => {
  const method = "_x.ai/compact_conversation";
  let requestId: string | null = null;
  return {
    async start(request, reply) {
      requestId = request.id;
      let native: unknown = null;
      let type = method;
      let outcome: "completed" | "failed" | "aborted" | null = null;
      try {
        native = await withAcpDeadline(runtime, method, null,
          // oxlint-disable-next-line typescript/promise-function-async -- SDK callback returns its native request promise.
          (options) => {
            const pending = runtime.connection.agent.request(method, { sessionId: kernel.sessionId }, options);
            reply({ kind: "accepted" });
            return pending;
          });
        if (asRecord(native) !== null) { outcome = "completed"; }
      } catch (error) {
        // Transport loss is not a native compaction failure or a known end.
        if (!(error instanceof RequestError)) { throw error; }
        native = acpErrorNative(error);
        const kind = asRecord(error.data)?.kind;
        if (kind === "compact_cancelled") { outcome = "aborted"; }
        if (kind === "compact_failed") { outcome = "failed"; }
        type = `${method}/error`;
      }
      kernel.frame({ type, native, responseTo: request.id, events: outcome === null ? [] : [{ kind: "compaction_ended", outcome, requestId: request.id }] });
    },
    observe(frame) {
      if (requestId === null || frame.body.responseTo !== requestId) { return null; }
      const event = frame.body.events.find(e => e.kind === "compaction_ended");
      if (event !== undefined) {
        return event.outcome === "failed"
          ? { kind: "failed", code: "native_failed", reason: "Grok reported native compaction failure", frame }
          : { kind: event.outcome, frame };
      }
      if (frame.body.type === `${method}/error`) {
        const native = asRecord(frame.body.native);
        return { kind: "rejected", code: "runtime_refused", reason: typeof native?.message === "string" ? native.message : "Grok refused the compact RPC" };
      }
      return { kind: "unconfirmed", code: "observation_failed", reason: "Grok answered without native compaction completion evidence" };
    },
  };
};
