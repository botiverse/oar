import type { AdapterSession, AppAsk, AppDecision, AskQuestion } from "../contracts/session.js";
import type { SessionKernel } from "../kernel.js";

/** How a scripted ask ended: the host's decision, or `withdrawn` when the turn was aborted or the session disposed first. */
export type ScriptedAnswer = AppDecision | { readonly kind: "withdrawn" };

/** A question a script asks; `id` defaults to the question text. */
export type ScriptedQuestion = Omit<AskQuestion, "id" | "multiSelect" | "other"> & {
  readonly id?: string;
  readonly multiSelect?: boolean;
  readonly other?: boolean;
};

/**
 * The scripted runtime's permission gate: what `ScriptedTurn.approve` and
 * `ask` record, how `Session.answer` reaches them, and their withdrawal when
 * their turn ends first. A turn is identified by any object it owns.
 */
export interface ScriptedAsks {
  approve(turn: object, tool: string, input: string): Promise<ScriptedAnswer>;
  ask(turn: object, questions: readonly ScriptedQuestion[]): Promise<ScriptedAnswer>;
  /** The turn is over: whatever it still asks is withdrawn, as a runtime withdraws a cancelled turn's requests. */
  withdraw(turn: object): void;
  readonly answer: AdapterSession["answer"];
}

export function createScriptedAsks(kernel: SessionKernel, runtimeId: string, gated: boolean): ScriptedAsks {
  const asking = new Map<string, { readonly turn: object; readonly settle: (answer: ScriptedAnswer) => void; readonly grant?: string }>();
  const granted = new Set<string>();
  let askCount = 0;

  async function askHost(turn: object, type: string, native: unknown, ask: AppAsk, grant?: string): Promise<ScriptedAnswer> {
    askCount += 1;
    const requestId = `scripted-ask-${String(askCount)}`;
    const { promise, resolve } = Promise.withResolvers<ScriptedAnswer>();
    asking.set(requestId, { turn, settle: resolve, ...(grant === undefined ? {} : { grant }) });
    kernel.request("toApp", { kind: "native", type, native, ask }, { id: requestId });
    const answer = await promise;
    return answer;
  }

  return {
    async approve(turn, tool, input) {
      const grant = JSON.stringify([tool, input]);
      if (!gated) {
        return { kind: "allow" };
      }
      if (granted.has(grant)) {
        return { kind: "allow", scope: "session" };
      }
      const answer = await askHost(turn, "scripted/approval", { tool, input }, {
        kind: "tool_approval", tool, input, choices: ["allow", "allow_session", "deny"], denyMessage: true,
      }, grant);
      return answer;
    },
    async ask(turn, questions) {
      if (!gated) {
        throw new Error(`${runtimeId}: questions need a session opened with approvals "ask"; no one is there to answer`);
      }
      const asked = questions.map((question): AskQuestion => ({
        ...question,
        id: question.id ?? question.question,
        multiSelect: question.multiSelect ?? false,
        other: question.other ?? false,
      }));
      const answer = await askHost(turn, "scripted/question", { questions: asked }, { kind: "question", questions: asked, choices: ["answer", "deny"], denyMessage: true });
      return answer;
    },
    withdraw(turn) {
      const withdrawn = [...asking].filter(([, pending]) => pending.turn === turn);
      if (withdrawn.length === 0) {
        return;
      }
      const requestIds = withdrawn.map(([requestId]) => requestId);
      kernel.frame({ type: "scripted/withdrawn", native: { requestIds }, events: requestIds.map((requestId) => ({ kind: "app_request_withdrawn", requestId })) });
      for (const [requestId, pending] of withdrawn) {
        asking.delete(requestId);
        pending.settle({ kind: "withdrawn" });
      }
    },
    // The script's own reply channel: the decision itself is what is "sent".
    async answer(requestId, decision) {
      await Promise.resolve();
      return kernel.answer(requestId, decision, (_request, taken) => {
        const pending = asking.get(requestId);
        if (pending === undefined) {
          return { kind: "rejected", code: "unsupported", reason: `${runtimeId} asked nothing under ${requestId}` };
        }
        asking.delete(requestId);
        if (taken.kind === "allow" && taken.scope === "session" && pending.grant !== undefined) {
          granted.add(pending.grant);
        }
        pending.settle(taken);
        return { kind: "sent", native: taken };
      });
    },
  };
}
