import { RequestError } from "@agentclientprotocol/sdk";
import type { AcpSessionProfile } from "../../shared/acp/profile.js";
import { withAcpDeadline } from "../../shared/acp/process.js";
import { acpErrorNative } from "../../shared/acp/projection.js";
import { asRecord } from "../../shared/json.js";

function committed(result: ReturnType<typeof asRecord>): boolean {
  return result?.status === "committed" && Number.isSafeInteger(result.revision)
    && Number.isSafeInteger(result.execution_generation)
    && typeof result.target_session_id === "string" && result.target_session_id.length > 0;
}

/**
 * Hermes's negotiated ACP extension fences the gateway's canonical
 * compression mutation with the session's current revision and generation.
 * The mutation answer is the completion proof; no prompt or replay is used.
 */
export const hermesCompaction: NonNullable<AcpSessionProfile["compaction"]> = (kernel, runtime) => {
  const method = "_hermes/session/compact";
  let requestId: string | null = null;
  return {
    async start(request, reply) {
      requestId = request.id;
      let native: unknown = null;
      let type = method;
      try {
        native = await withAcpDeadline(runtime, method, null,
          // oxlint-disable-next-line typescript/promise-function-async -- SDK callback returns its native request promise.
          (options) => {
            const pending = runtime.connection.agent.request(method, { sessionId: kernel.sessionId }, options);
            reply({ kind: "accepted" });
            return pending;
          });
      } catch (error) {
        if (!(error instanceof RequestError)) { throw error; }
        type = `${method}/error`;
        native = acpErrorNative(error);
      }
      const result = asRecord(native);
      const didCommit = type === method && committed(result);
      const events = didCommit
        ? [{ kind: "compaction_ended" as const, outcome: "completed" as const, requestId: request.id }]
        : [];
      kernel.frame({ type, native, responseTo: request.id, events });
      if (!didCommit && (type !== method || (result?.status !== "noop" && result?.status !== "refused"))) {
        // Once dispatched, ambiguity must keep the input fence until the session is released.
        throw new Error("Hermes did not confirm native compaction; reopen the session before sending input");
      }
    },
    observe(frame) {
      if (requestId === null || frame.body.responseTo !== requestId || frame.body.type !== method) { return null; }
      const result = asRecord(frame.body.native);
      switch (result?.status) {
        case "committed":
          return committed(result) ? { kind: "completed", frame } : null;
        case "noop":
          return { kind: "failed", code: "not_compacted", reason: "Hermes reported that compression made no changes", frame };
        case "refused":
          return { kind: "rejected", code: "runtime_refused", reason: typeof result.reason === "string" ? result.reason : "Hermes refused native compression" };
        default:
          return null;
      }
    },
  };
};

/** Hermes's compact control is available only when the ACP extension is negotiated. */
export function hermesCompactionAdvertised(initialized: Record<string, unknown>): boolean {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- ACP extension metadata.
  return asRecord(initialized._meta)?.["hermes/compact"] === true;
}
