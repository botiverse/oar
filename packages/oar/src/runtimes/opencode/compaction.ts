import type { Frame, RuntimeEventBody } from "../../contracts/session.js";
import { promptAcp, type AcpSessionProfile } from "../../shared/acp/profile.js";
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

export const opencodeCompaction: NonNullable<AcpSessionProfile["compaction"]> = (kernel, runtime) => {
  let messageId: string | null = null;
  let settlement: CompactionSettlement | null = null;
  return {
    async start(_request, reply) {
      const pending = promptAcp(runtime, kernel.sessionId, [{ type: "text", text: "/compact" }]);
      reply({ kind: "accepted" });
      const native = await pending;
      kernel.frame({ type: "session/prompt", native, events: [] });
      if (settlement === null) { throw new Error("OpenCode ended the compact prompt without a matching native compaction end"); }
      return settlement;
    },
    observe(frame: Frame) {
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
