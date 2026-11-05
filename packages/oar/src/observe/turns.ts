import { droppedOutcome, inputRequestAt, inputWait } from "./input-wait.js";
import { initialStatus, reduceStatus } from "./agent-status.js";
import { exitTurnOutcome, releaseTurnOutcome } from "./turn-stop.js";
import type { ControlOutcome, InputImage, RejectionCode, Session, RawEvent, TurnOutcome } from "../contracts/session.js";

/**
 * Turn helpers for consumers. A turn is a SPAN on the stream, not a control
 * object: a prompt request is its fallback start; native input_queued and
 * turn_active with inputId can establish its actual start. It ends at the runtime's own
 * `turn_ended` event or at an observed process exit. Session release also ends OAR's wait,
 * without proving native work stopped. A native before-start input drop
 * also resolves an input-scoped wait (aborted for interruption, failed for refusal), without synthesizing a turn end.
 *
 * Scope: the ROOT SESSION's ROOT AGENT. A derived child session's records
 * (codex child threads, grok child sessions) carry the child's own `sessionId`
 * and `agentPath []`; its `turn_ended` is that child's turn, not the root's.
 * Observed live on codex 0.149.0, where the child's `turn/completed` reached
 * the stream BEFORE the root's.
 */

/**
 * The root-agent turn end after `afterSeq`, if the stream already holds one:
 * the runtime's turn_ended event, an observed process exit, or session release.
 * Release ends the wait without proving native work stopped. When `sessionId`
 * is given, only that session's records count. inputId gates on a matching
 * native input_queued until its turn_active; without that evidence, the first
 * end wins. A matching input drop resolves as aborted for interruption or
 * failed for refusal. A native handled receipt instead returns InputHandled.
 * Accepted withdrawal of held input resolves as aborted; rejection of its
 * recorded dispatch resolves as failed, including logs without a drop frame.
 * Requests marked admission: "native" wait for their own admission evidence,
 * excluding independent native ends while preflight is still pending.
 */
export function turnEndAfter(records: readonly RawEvent[], afterSeq: number, sessionId?: string, inputId?: undefined): TurnOutcome | null;
export function turnEndAfter(records: readonly RawEvent[], afterSeq: number, sessionId: string | undefined, inputId: string | undefined): TurnOutcome | InputHandled | null;
export function turnEndAfter(
  records: readonly RawEvent[],
  afterSeq: number,
  sessionId?: string,
  inputId?: string,
): TurnOutcome | InputHandled | null {
  const read = turnEndReader(afterSeq, sessionId, inputId, undefined, inputRequestAt(records, afterSeq, sessionId, inputId));
  for (const record of records) {
    const outcome = read(record);
    if (outcome !== null) { return outcome; }
  }
  return null;
}

/** Native input disposition, deliberately separate from a TurnOutcome. */
export interface InputHandled {
  readonly kind: "handled";
  readonly requestId: string;
  readonly inputId?: string;
  /** Cursor of the frame carrying the native handling evidence. */
  readonly seq: number;
}

/** Keep request/response correlation across both the retained prefix and live records. */
function turnEndReader(afterSeq: number, sessionId?: string, inputId?: string, onText?: (text: string) => void, boundRequest?: string): (record: RawEvent) => TurnOutcome | InputHandled | null {
  let status = initialStatus;
  const input = inputWait(afterSeq, inputId, boundRequest);
  return (record) => {
    if (record.agentPath.length > 0 || (sessionId !== undefined && record.sessionId !== sessionId)) {
      return null;
    }
    const disposition = input.read(record);
    const previous = status;
    status = reduceStatus(previous, record, sessionId);
    if (previous.kind === "idle" && previous.released === true) {
      return record.seq > afterSeq && record.kind === "response" && record.body.kind === "exited"
        ? exitTurnOutcome(undefined, record.body.reason) : null;
    }
    if (disposition !== null) { return disposition; }
    if (record.kind === "frame") {
      for (const event of record.body.events) {
        if (record.seq > afterSeq && !input.waiting() && event.kind === "text_delta") { onText?.(event.text); }
        if (record.seq > afterSeq && !input.waiting() && event.kind === "turn_ended") { return event.outcome; }
      }
    }
    if (record.seq <= afterSeq || record.kind !== "response") { return null; }
    const stop = previous.kind === "running" ? previous.stop ?? previous.pendingPrompt?.stop : previous.pendingPrompt?.stop;
    if (record.body.kind === "released") { return releaseTurnOutcome(stop); }
    return record.body.kind === "exited" ? exitTurnOutcome(stop, record.body.reason) : null;
  };
}

/**
 * Resolve with the first turn end of the session's root agent recorded after
 * `afterSeq`, from the retained log if it already happened, otherwise live.
 * An observed process exit or session release also resolves it; release does
 * not prove native work stopped, and late native frames cannot revise its outcome.
 * A derived child session's turn end never satisfies it. With inputId, native
 * queue/start evidence excludes intervening turns; explicit native admission
 * also excludes turns that finish during that input's preflight. Handled input
 * returns InputHandled. Unscoped next-turn waits keep their existing behavior.
 * A withdrawn held input or refused dispatch also resolves its scoped wait.
 */
export function awaitTurnEnd(session: Session, afterSeq: number, inputId?: undefined): Promise<TurnOutcome>;
export function awaitTurnEnd(session: Session, afterSeq: number, inputId: string | undefined): Promise<TurnOutcome | InputHandled>;
export async function awaitTurnEnd(session: Session, afterSeq: number, inputId?: string): Promise<TurnOutcome | InputHandled> {
  const outcome = await watchTurn(session, afterSeq, inputId);
  return outcome;
}

/** One reader owns both the turn boundary and its text, including replay before subscription. */
async function watchTurn(session: Session, afterSeq: number, inputId?: string, onText?: (text: string) => void, requestId?: string): Promise<TurnOutcome | InputHandled> {
  const { promise, resolve } = Promise.withResolvers<TurnOutcome | InputHandled>();
  let done = false;
  const read = turnEndReader(afterSeq, session.id, inputId, onText, requestId ?? inputRequestAt(session.records(), afterSeq, session.id, inputId));
  const unsubscribe = session.rawEvents((record) => {
    if (done) { return; }
    const outcome = read(record);
    if (outcome !== null) { done = true; resolve(outcome); }
  }, { sessionId: session.id, afterSeq: -1 });
  try { return await promise; } finally { unsubscribe(); }
}

/**
 * Resolve once the root agent is idle: at once (null) when `session.status()`
 * already says so, otherwise with the outcome when the owned input and any
 * intervening turn are no longer pending. The status is read and the subscription placed through one cursor,
 * so a turn ending in between is not missed. Nothing is prompted here: a
 * runtime that runs a queued input as a turn of its own makes the next
 * prompt `busy`, and this is how a caller waits that out instead of polling.
 */
export async function awaitIdle(session: Session): Promise<TurnOutcome | null> {
  const status = session.status();
  if (status.value.kind === "idle" && status.value.pendingPrompt === undefined) {
    return null;
  }
  const { promise, resolve } = Promise.withResolvers<TurnOutcome | null>();
  let state = initialStatus;
  const unsubscribe = session.rawEvents(record => {
    const previous = state;
    state = reduceStatus(state, record, session.id);
    if (record.seq <= status.seq || record.sessionId !== session.id || record.agentPath.length > 0
      || state.kind !== "idle" || state.pendingPrompt !== undefined) { return; }
    if (record.kind === "frame") {
      const ended = record.body.events.find(event => event.kind === "turn_ended");
      const dropped = record.body.events.find(event => event.kind === "input_dropped");
      resolve(ended?.kind === "turn_ended" ? ended.outcome : (dropped?.kind === "input_dropped" ? droppedOutcome(dropped) : null));
      return;
    }
    const stop = previous.kind === "running" ? previous.stop ?? previous.pendingPrompt?.stop : previous.pendingPrompt?.stop;
    if (record.kind === "response" && record.body.kind === "exited") { resolve(exitTurnOutcome(stop, record.body.reason)); }
    else if (record.kind === "response" && record.body.kind === "released") { resolve(releaseTurnOutcome(stop)); }
    else { resolve(null); }
  }, { sessionId: session.id, afterSeq: -1 });
  try { return await promise; } finally { unsubscribe(); }
}

export interface PromptRunOptions {
  /** Input identity for native turn correlation. A fresh UUID is used when omitted. */
  readonly inputId?: string;
  /** Abort the turn when it has not ended after this long; the run then reports `interrupted` with the observed turn outcome. */
  readonly timeoutMs?: number;
  /** Abort the turn when this fires (a caller-side cancel), reported the same way. */
  readonly signal?: AbortSignal;
  /** Images to send with the prompt (`InputOptions.images`). */
  readonly images?: readonly InputImage[];
}

export type PromptRun =
  /** Native input handling without a model turn. Handler failures remain separate records; this is not success. */
  | { readonly kind: "handled"; readonly result: ControlOutcome; readonly disposition: InputHandled }
  /** The prompt did not begin a turn (busy, dead runtime); nothing was waited for. */
  | { readonly kind: "rejected"; readonly result: ControlOutcome; readonly code: RejectionCode; readonly reason: string }
  /** The runtime ended the turn, dropped the input or exited, or OAR released the session. `text` is the root agent's text of this turn, concatenated. */
  | { readonly kind: "ended"; readonly result: ControlOutcome; readonly outcome: TurnOutcome; readonly text: string }
  /** The caller's timeout or signal fired first and the abort was taken over; `outcome` is the native turn end, an observed exit or session release after the stop. */
  | { readonly kind: "interrupted"; readonly by: "timeout" | "signal"; readonly result: ControlOutcome; readonly outcome: TurnOutcome; readonly text: string };

/**
 * Prompt, then wait for the runtime to end the turn it opened. A rejected
 * prompt returns without waiting. Sends the caller's inputId or a fresh UUID
 * to correlate native queue/start facts, without requiring that evidence. With `timeoutMs` / `signal`, a turn still
 * running when either fires is aborted; the result is `interrupted` only when
 * that abort was taken over. An abort the runtime refuses because the turn
 * had just ended is the ordinary late-abort race, and the run is `ended`.
 * After an accepted abort the turn's end is awaited with no further limit:
 * a native turn end keeps its outcome; exit or release after that accepted abort is
 * `aborted`. A native before-start input drop resolves as `aborted` for interruption or `failed` for refusal.
 * Native input handling returns the separate handled branch, without borrowing
 * an independent run's text or outcome. Without one of these facts the helper
 * continues waiting.
 */
export async function promptAndWait(session: Session, input: string, options: PromptRunOptions = {}): Promise<PromptRun> {
  const inputId = options.inputId ?? globalThis.crypto.randomUUID();
  const result = await session.prompt(input, { inputId, ...(options.images === undefined ? {} : { images: options.images }) });
  if (result.kind === "rejected") {
    return { kind: "rejected", result, code: result.code, reason: result.reason };
  }
  const disposition = handledAttempt(session, result.requestId);
  if (disposition !== undefined) { return { kind: "handled", result, disposition }; }
  let text = "";
  const limit = armLimits(options);
  try {
    const ended = watchTurn(session, result.seq, inputId, (delta) => { text += delta; }, result.request.id);
    const first = await Promise.race([ended, limit.fired]);
    if (typeof first !== "string") {
      return first.kind === "handled" ? { kind: "handled", result, disposition: first } : { kind: "ended", result, outcome: first, text };
    }
    // A receipt may have arrived while the caller's already-fired limit and
    // the live reader were settling. Never abort an unrelated extension run.
    const handledNow = handledAttempt(session, result.requestId);
    if (handledNow !== undefined) { return { kind: "handled", result, disposition: handledNow }; }
    const abort = await session.abort();
    const outcome = await ended;
    if (outcome.kind === "handled") { return { kind: "handled", result, disposition: outcome }; }
    return abort.kind === "accepted"
      ? { kind: "interrupted", by: first, result, outcome, text }
      : { kind: "ended", result, outcome, text };
  } finally {
    limit.disarm();
  }
}

function handledAttempt(session: Session, requestId: string): InputHandled | undefined {
  for (const record of session.records()) {
    if (record.kind !== "frame" || record.sessionId !== session.id || record.agentPath.length > 0) { continue; }
    const event = record.body.events.find(item => item.kind === "input_handled" && item.requestId === requestId);
    if (event?.kind === "input_handled") {
      return { kind: "handled", requestId, ...(event.inputId === undefined ? {} : { inputId: event.inputId }), seq: record.seq };
    }
  }
  return undefined;
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
