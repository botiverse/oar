import type { Frame } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { CompactionOperation } from "../../shared/manual-compaction.js";
import type { AppServerClient } from "./app-server-client.js";

/** The native compaction item identifies its root turn; an autonomous goal turn is not admission evidence. */
export function codexCompaction(client: Pick<AppServerClient, "request">, threadId: string): CompactionOperation & { turnId(): string | null } {
  let turnId: string | null = null;
  let itemId: string | null = null;
  let boundary: Frame | null = null;
  return {
    turnId: () => turnId,
    async start(_request, reply) {
      await client.request("thread/compact/start", { threadId }, (outcome) => {
        reply(outcome.kind === "result" ? { kind: "accepted", native: outcome.result }
          : { kind: "rejected", code: outcome.kind === "exited" ? "runtime_exited" : "runtime_refused", reason: outcome.error.message, ...(outcome.kind === "error" ? { native: outcome.native } : {}) });
      });
    },
    observe(frame) {
      const native = asRecord(frame.body.native);
      if (native?.threadId !== threadId) { return null; }
      const turn = asRecord(native.turn);
      const item = asRecord(native.item);
      if (turnId === null && frame.body.type === "item/started" && item?.type === "contextCompaction" && typeof item.id === "string" && typeof native.turnId === "string") { turnId = native.turnId; }
      if (turnId === null) { return null; }
      if (native.turnId === turnId && item?.type === "contextCompaction") {
        if (frame.body.type === "item/started" && typeof item.id === "string") { itemId = item.id; }
        if (frame.body.type === "item/completed" && itemId !== null && item.id === itemId) { boundary = frame; }
      }
      if (frame.body.type !== "turn/completed" || turn?.id !== turnId) { return null; }
      if (turn.status === "interrupted") { return { kind: "aborted", frame }; }
      if (turn.status === "failed") { return { kind: "failed", code: "native_failed", reason: "Codex reported that the compaction turn failed", frame }; }
      return turn.status === "completed" && boundary !== null
        ? { kind: "completed", frame: boundary }
        : { kind: "failed", code: "not_compacted", reason: "Codex ended the compaction turn without a matching completed contextCompaction item", frame };
    },
  };
}

/** A submitted queue entry can start before compact reaches the server, even while no turn is active yet. */
export function codexCompactionBusy(kernel: SessionKernel, active: () => boolean): () => boolean {
  const waiting = new Map<string, string>();
  let activeGoal = false;
  kernel.rawEvents((record) => {
    if (record.sessionId !== kernel.sessionId || record.agentPath.length > 0) { return; }
    if (record.kind === "request" && record.body.kind === "queue") { waiting.set(record.id, record.body.inputId ?? record.id); }
    if (record.kind === "response" && record.body.kind === "rejected") { waiting.delete(record.requestId); }
    if (record.kind === "frame") {
      for (const event of record.body.events) {
        if (event.kind === "goal_changed") { activeGoal = event.goal?.status === "active"; }
        if (event.kind !== "user_message" || event.inputId === undefined) { continue; }
        for (const [id, inputId] of waiting) { if (inputId === event.inputId) { waiting.delete(id); } }
      }
    }
  });
  return () => active() || activeGoal || waiting.size > 0;
}
