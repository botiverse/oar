import type { ControlOutcome, RejectionCode, Session, RawEvent, TurnOutcome } from "../contracts/session.js";

/**
 * Turn helpers for consumers. A turn is a SPAN on the stream, not a control
 * object: it starts at the prompt request record and ends at the runtime's own
 * `turn_ended` event (or at the process exit oar observed). These folds locate
 * that end; they never synthesize one.
 *
 * Scope: the ROOT SESSION's ROOT AGENT. A derived child session's records
 * (codex child threads, grok child sessions) carry the child's own `sessionId`
 * and `agentPath []`; its `turn_ended` is that child's turn, not the root's.
 * Observed live on codex 0.149.0, where the child's `turn/completed` reached
 * the stream BEFORE the root's.
 */

/**
 * The root-agent turn end after `afterSeq`, if the stream already holds one:
 * the runtime's turn_ended event, or an observed process exit. When `sessionId`
 * is given, only that session's records count.
 */
export function turnEndAfter(
  records: readonly RawEvent[],
  afterSeq: number,
  sessionId?: string,
): TurnOutcome | null {
  for (const record of records) {
    if (record.seq <= afterSeq || record.agentPath.length > 0) {
      continue;
    }
    if (sessionId !== undefined && record.sessionId !== sessionId) {
      continue;
    }
    if (record.kind === "frame") {
      const ended = record.body.events.find((event) => event.kind === "turn_ended");
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

/**
 * Resolve with the first turn end of the session's root agent recorded after
 * `afterSeq`, from the retained log if it already happened, otherwise live.
 * A derived child session's turn end never satisfies it.
 */
export async function awaitTurnEnd(session: Session, afterSeq: number): Promise<TurnOutcome> {
  const { promise, resolve } = Promise.withResolvers<TurnOutcome>();
  let done = false;
  const unsubscribe = session.rawEvents((record) => {
    if (done) {
      return;
    }
    const outcome = turnEndAfter([record], afterSeq, session.id);
    if (outcome !== null) {
      done = true;
      resolve(outcome);
    }
  }, { sessionId: session.id, afterSeq });
  const outcome = await promise;
  unsubscribe();
  return outcome;
}

/**
 * Resolve once the root agent is idle: at once (null) when `session.status()`
 * already says so, otherwise with the outcome of the running turn when it
 * ends. The status is read and the subscription placed through one cursor,
 * so a turn ending in between is not missed. Nothing is prompted here: a
 * runtime that runs a queued input as a turn of its own makes the next
 * prompt `busy`, and this is how a caller waits that out instead of polling.
 */
export async function awaitIdle(session: Session): Promise<TurnOutcome | null> {
  const status = session.status();
  if (status.value.kind === "idle") {
    return null;
  }
  const outcome = await awaitTurnEnd(session, status.value.sinceSeq);
  return outcome;
}

export interface PromptRunOptions {
  /** Abort the turn when it has not ended after this long; the run then reports `interrupted` with the runtime's own outcome. */
  readonly timeoutMs?: number;
  /** Abort the turn when this fires (a caller-side cancel), reported the same way. */
  readonly signal?: AbortSignal;
}

export type PromptRun =
  /** The prompt did not begin a turn (busy, dead runtime); nothing was waited for. */
  | { readonly kind: "rejected"; readonly result: ControlOutcome; readonly code: RejectionCode; readonly reason: string }
  /** The runtime ended the turn on its own. `text` is the root agent's text of this turn, concatenated. */
  | { readonly kind: "ended"; readonly result: ControlOutcome; readonly outcome: TurnOutcome; readonly text: string }
  /** The caller's timeout or signal fired first and the abort was taken over; `outcome` is still the runtime's own turn end. */
  | { readonly kind: "interrupted"; readonly by: "timeout" | "signal"; readonly result: ControlOutcome; readonly outcome: TurnOutcome; readonly text: string };

/**
 * Prompt, then wait for the runtime to end the turn it opened. A rejected
 * prompt returns without waiting. With `timeoutMs` / `signal`, a turn still
 * running when either fires is aborted; the result is `interrupted` only when
 * that abort was taken over. An abort the runtime refuses because the turn
 * had just ended is the ordinary late-abort race, and the run is `ended`.
 * After an accepted abort the turn's end is awaited with no further limit:
 * the outcome is the runtime's word, and a runtime that never gives it is a
 * liveness problem `observeStalls` reports, not one this helper guesses at.
 */
export async function promptAndWait(session: Session, input: string, options: PromptRunOptions = {}): Promise<PromptRun> {
  const result = await session.prompt(input);
  if (result.kind === "rejected") {
    return { kind: "rejected", result, code: result.code, reason: result.reason };
  }
  let text = "";
  const stopReading = session.rawEvents((record) => {
    if (record.kind === "frame" && record.agentPath.length === 0 && record.sessionId === session.id) {
      for (const event of record.body.events) {
        if (event.kind === "text_delta") {
          text += event.text;
        }
      }
    }
  }, { sessionId: session.id, afterSeq: result.seq });
  const limit = armLimits(options);
  try {
    const ended = awaitTurnEnd(session, result.seq);
    const first = await Promise.race([ended, limit.fired]);
    if (typeof first !== "string") {
      return { kind: "ended", result, outcome: first, text };
    }
    const abort = await session.abort();
    const outcome = await ended;
    return abort.kind === "accepted"
      ? { kind: "interrupted", by: first, result, outcome, text }
      : { kind: "ended", result, outcome, text };
  } finally {
    limit.disarm();
    stopReading();
  }
}

/** The caller's limits as one promise that settles with whichever fires first (never, when none is set), and the disarm for when the turn ends first. */
function armLimits(options: PromptRunOptions): { readonly fired: Promise<"timeout" | "signal">; readonly disarm: () => void } {
  const { promise: fired, resolve } = Promise.withResolvers<"timeout" | "signal">();
  const timer = options.timeoutMs === undefined ? null : setTimeout(() => { resolve("timeout"); }, options.timeoutMs);
  const onAbort = (): void => { resolve("signal"); };
  if (options.signal?.aborted === true) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    fired,
    disarm: () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}
