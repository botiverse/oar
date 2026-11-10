import type { TurnOutcome } from "../../contracts/session.js";
import type { AcpNativeTurns } from "../../shared/acp/profile.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * Grok runs turns OAR never prompted: a finished sub-agent wakes its parent
 * (`subagent-completed-*`), an interjection that missed its turn runs on its
 * own (`interject-fallback-*`), and more (grok-build 2bdd1d6: `bash-completed-*`,
 * `goal-summary-*`, ...). Grok takes the client's `_meta.promptId` verbatim
 * (acp_agent.rs `prompt`), so OAR names its own prompts and every other name is
 * Grok's. Its `_x.ai/queue/changed` lists held prompt ids and the running one
 * (`runningPromptId`); its `turn_completed` closes a turn by `prompt_id`
 * (live 1.0.77: experiments/grok-interject/README.md).
 */
export const grokNativeTurns: AcpNativeTurns = {
  promptMeta: (promptId) => ({ promptId }),
  read(method, params) {
    if (method === "_x.ai/queue/changed") {
      const entries = Array.isArray(params.entries) ? params.entries : [];
      const queued = entries.flatMap((entry: unknown) => {
        const id = asRecord(entry)?.id;
        return typeof id === "string" && id !== "" ? [id] : [];
      });
      const running = typeof params.runningPromptId === "string" && params.runningPromptId !== "" ? params.runningPromptId : null;
      return { kind: "queue", running, queued };
    }
    if (method !== "_x.ai/session_notification") { return null; }
    const update = asRecord(params.update);
    if (update?.sessionUpdate !== "turn_completed" || typeof update.prompt_id !== "string" || update.prompt_id === "") { return null; }
    // A later wake of the same child reuses its prompt id; the native event id tells the reports apart.
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
    const key = asRecord(params._meta)?.eventId;
    return { kind: "ended", promptId: update.prompt_id, outcome: grokTurnOutcome(update), ...(typeof key === "string" && key !== "" ? { key } : {}) };
  },
};

/** `stop_reason`: the model's (`end_turn`, ...), `cancelled`, or `error` with the message in `agent_result` (turn_completion.rs). */
function grokTurnOutcome(update: JsonRecord): TurnOutcome {
  if (update.stop_reason === "cancelled") { return { kind: "aborted" }; }
  if (update.stop_reason === "error") {
    const reason = typeof update.agent_result === "string" && update.agent_result !== "" ? update.agent_result : "Grok reported an error";
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return { kind: "completed" };
}
