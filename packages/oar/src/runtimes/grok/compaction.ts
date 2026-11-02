import { RequestError } from "@agentclientprotocol/sdk";
import type { AcpSessionProfile } from "../../shared/acp/profile.js";
import { withAcpDeadline } from "../../shared/acp/process.js";
import { acpErrorNative } from "../../shared/acp/projection.js";
import { asRecord } from "../../shared/json.js";

/** The dedicated RPC response is correlated by the SDK. Notifications alone prove no request ownership. */
export const grokCompaction: NonNullable<AcpSessionProfile["compaction"]> = (kernel, runtime) => {
  const method = "_x.ai/compact_conversation";
  return {
    async start(request, reply) {
      let native: unknown = null;
      let outcome: "completed" | "failed" | "aborted" = "completed";
      let type = method;
      try {
        const pending = withAcpDeadline(runtime, method, null,
          // oxlint-disable-next-line typescript/promise-function-async -- SDK callback returns its native request promise.
          (options) => runtime.connection.agent.request(method, { sessionId: kernel.sessionId }, options));
        reply({ kind: "accepted" });
        native = await pending;
        if (asRecord(native) === null) { throw new TypeError("Grok compact returned a non-object response"); }
      } catch (error) {
        // Transport loss is not a native compaction failure; the shared wait remains unconfirmed.
        if (!(error instanceof RequestError)) { throw error; }
        native = acpErrorNative(error);
        outcome = asRecord(error.data)?.kind === "compact_cancelled" ? "aborted" : "failed";
        type = `${method}/error`;
      }
      const frame = kernel.frame({ type, native, events: [{ kind: "compaction_ended", outcome, requestId: request.id }] });
      return outcome === "failed"
        ? { kind: "failed", code: "native_failed", reason: "Grok rejected its native compact RPC", frame }
        : { kind: outcome, frame };
    },
    observe: () => null,
  };
};
