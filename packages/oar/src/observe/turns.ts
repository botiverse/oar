import type {
  ControlResult,
  Session,
  SessionRecord,
  TurnOutcome,
} from "../contracts/session.js";

/**
 * Turn helpers for consumers. A turn is a SPAN on the stream, not a control
 * object: it starts at the prompt request record and ends at the runtime's
 * own `turn_ended` event (or at the process exit oar observed). These folds
 * locate that end; they never synthesize one.
 */

/** The root-agent turn end after `afterSeq`, if the stream already holds one: the runtime's turn_ended view, or an observed process exit. */
export function turnEndAfter(records: readonly SessionRecord[], afterSeq: number): TurnOutcome | null {
  for (const record of records) {
    if (record.seq <= afterSeq || record.agentPath.length > 0) {
      continue;
    }
    if (record.kind === "event") {
      const ended = record.body.views.find((view) => view.kind === "turn_ended");
      if (ended?.kind === "turn_ended") {
        return ended.outcome;
      }
    }
    if (record.kind === "response" && record.body.kind === "exited") {
      return { kind: "failed", reason: "runtime exited", failure: "runtime_exited" };
    }
  }
  return null;
}

/** Resolve with the first root-agent turn end recorded after `afterSeq` — from the retained log if it already happened, otherwise live. */
export async function awaitTurnEnd(session: Session, afterSeq: number): Promise<TurnOutcome> {
  const { promise, resolve } = Promise.withResolvers<TurnOutcome>();
  let done = false;
  const unsubscribe = session.subscribe((record) => {
    if (done) {
      return;
    }
    const outcome = turnEndAfter([record], afterSeq);
    if (outcome !== null) {
      done = true;
      resolve(outcome);
    }
  }, { sessionId: session.id, afterSeq });
  const outcome = await promise;
  unsubscribe();
  return outcome;
}

export type PromptRun =
  | { readonly kind: "rejected"; readonly result: ControlResult; readonly reason: string }
  | { readonly kind: "ended"; readonly result: ControlResult; readonly outcome: TurnOutcome };

/** Prompt, then wait for the runtime to end the turn it opened. A rejected prompt (busy, dead runtime) returns without waiting. */
export async function promptAndWait(session: Session, input: string): Promise<PromptRun> {
  const result = await session.prompt(input);
  if (result.response.body.kind !== "accepted") {
    const reason = result.response.body.kind === "rejected" ? result.response.body.reason : result.response.body.kind;
    return { kind: "rejected", result, reason };
  }
  const outcome = await awaitTurnEnd(session, result.request.seq);
  return { kind: "ended", result, outcome };
}
