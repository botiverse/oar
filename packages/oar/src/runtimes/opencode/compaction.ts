import { RequestError } from "@agentclientprotocol/sdk";
import { setImmediate as settleUpdates } from "node:timers/promises";
import { withAcpDeadline } from "../../shared/acp/process.js";
import { acpErrorNative } from "../../shared/acp/projection.js";
import type { Frame, RuntimeEventBody } from "../../contracts/session.js";
import type { AcpSessionProfile } from "../../shared/acp/profile.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { CompactionSettlement } from "../../shared/manual-compaction.js";

function marker(update: JsonRecord): JsonRecord | null {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native OpenCode ACP metadata.
  return asRecord(asRecord(update._meta)?.["opencode/compaction"]);
}
function terminal(value: JsonRecord): "completed" | "aborted" | "failed" | null {
  if (value.status === "completed") { return "completed"; }
  if (value.status !== "failed") { return null; }
  const error = asRecord(value.error)?.type;
  return error === "aborted" || error === "compaction.interrupted" ? "aborted" : "failed";
}

/** v2 reports compaction facts independently of the ordinary prompt result. */
export function opencodeCompactionEvents(update: JsonRecord): readonly RuntimeEventBody[] {
  const value = marker(update);
  if (value === null) { return []; }
  const identity = typeof value.messageId === "string" ? { compactionId: value.messageId } : {};
  const trigger = typeof value.reason === "string" ? { trigger: value.reason } : {};
  if (value.status === "started") { return [{ kind: "compaction_started", ...identity, ...trigger }]; }
  const outcome = terminal(value);
  return outcome === null ? [] : [{ kind: "compaction_ended", outcome, ...identity, ...trigger }];
}

export const opencodeCompaction: NonNullable<AcpSessionProfile["compaction"]> = (kernel, runtime, promptUsage) => {
  let requestId: string | null = null;
  let messageId: string | null = null;
  let settlement: CompactionSettlement | null = null;
  return {
    async start(request, reply) {
      requestId = request.id;
      let native: unknown = null;
      let type = "session/prompt";
      try {
        native = await withAcpDeadline(runtime, type, null,
          // oxlint-disable-next-line typescript/promise-function-async -- Direct SDK dispatch, then admission.
          (options) => {
            const pending = runtime.connection.agent.request(type, { sessionId: kernel.sessionId, prompt: [{ type: "text", text: "/compact" }] }, options);
            reply({ kind: "accepted" });
            return pending;
          });
      } catch (error) {
        if (!(error instanceof RequestError)) { throw error; }
        type = "session/prompt/error";
        native = acpErrorNative(error);
      }
      // The SDK router yields between updates; consume every preceding marker before settlement.
      await settleUpdates();
      const response = type === "session/prompt" ? asRecord(native) : null;
      const usage = response === null ? null : promptUsage(response);
      kernel.frame({ type, native, responseTo: request.id, events: usage === null ? [] : [usage] });
    },
    observe(frame: Frame) {
      if (requestId !== null && frame.body.responseTo === requestId) {
        if (frame.body.type === "session/prompt/error") { return { kind: "failed", code: "native_failed", reason: "OpenCode returned a native compact prompt error", frame }; }
        return settlement ?? { kind: "unconfirmed", code: "observation_failed", reason: "OpenCode answered without a matching native compaction end" };
      }
      const update = asRecord(asRecord(frame.body.native)?.update);
      const value = update === null ? null : marker(update);
      if (value === null || value.reason !== "manual" || typeof value.messageId !== "string") { return null; }
      if (value.status === "started" && messageId === null) { messageId = value.messageId; }
      if (messageId !== value.messageId || settlement !== null) { return null; }
      const outcome = terminal(value);
      if (outcome !== null) {
        settlement = outcome === "failed"
          ? { kind: "failed", code: "native_failed", reason: "OpenCode reported that native compaction failed", frame }
          : { kind: outcome, frame };
      }
      // The marker and the RPC answer are both required before releasing queued input.
      return null;
    },
  };
};
