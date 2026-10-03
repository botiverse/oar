import type { ConversationInput, ConversationState } from "./conversation.js";
import { sealTurn, type Draft } from "./session-view-fold.js";

/**
 * Where a user input enters the session view: the INPUT rule in the
 * `session-view.ts` header (issue #82), applied per input update.
 */

/**
 * Whether an input waits in `pendingInputs` for its native echo instead of
 * entering `messages` now: a steer or queue the runtime has not echoed yet,
 * on a stream that echoes input ids, which it shows by having echoed one
 * before. Never a prompt still in play (it opens its turn) or a refused
 * input (shown where it was refused). No runtime name or capability decides
 * this; the stream itself does.
 */
export function awaitsEcho(input: ConversationInput, conversation: ConversationState): boolean {
  if (input.observations.length > 0 || input.state === "rejected") {
    return false;
  }
  if (input.attempts.some((attempt) => attempt.request.body.kind === "prompt" && attempt.state !== "rejected")) {
    return false;
  }
  for (const known of conversation.inputs.values()) {
    if (known.observations.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Upsert a user input. One waiting for its echo goes to `pendingInputs`;
 * otherwise it enters `messages`, and a NEW entry seals the open segment
 * (seq order is render order). A placed input that must now wait (a refused
 * attempt retried as a steer or queue) leaves `messages` again. A withdrawn
 * input leaves both lists.
 */
export function upsertInput(draft: Draft, input: ConversationInput, awaitEcho: boolean): void {
  const id = `in:${input.id}`;
  const index = draft.messages.findIndex((message) => message.id === id);
  if (input.state === "withdrawn") {
    withdrawInput(draft, input, index);
    return;
  }
  if (index !== -1 && !awaitEcho) {
    draft.messages[index] = { kind: "input", id, input };
    return;
  }
  if (index !== -1) {
    removeInput(draft, index);
  }
  const pending = draft.pendingInputs.findIndex((waiting) => waiting.id === input.id);
  if (awaitEcho) {
    if (pending === -1) {
      draft.pendingInputs.push(input);
    } else {
      draft.pendingInputs[pending] = input;
    }
    return;
  }
  if (pending !== -1) {
    draft.pendingInputs.splice(pending, 1);
  }
  draft.messages.push({ kind: "input", id, input });
  sealTurn(draft);
}

/**
 * An input taken back before it was sent leaves `pendingInputs` and, on a
 * stream that placed it at its request, `messages`. Unlike `removeInput`, the
 * segment its entry sealed stays sealed: the records folded since were
 * placed around it, and joining the segments again would be a merge the
 * stream never said.
 */
function withdrawInput(draft: Draft, input: ConversationInput, index: number): void {
  if (index !== -1) {
    draft.messages.splice(index, 1);
    if (draft.openTurn > index) {
      draft.openTurn -= 1;
    }
  }
  const pending = draft.pendingInputs.findIndex((waiting) => waiting.id === input.id);
  if (pending !== -1) {
    draft.pendingInputs.splice(pending, 1);
  }
}

/**
 * Take a placed input back out of `messages`. When it was the last message,
 * the outcome-less turn right before it is the segment its entry sealed, so
 * that segment opens again instead of splitting at an input no longer there.
 */
function removeInput(draft: Draft, index: number): void {
  draft.messages.splice(index, 1);
  if (draft.openTurn > index) {
    draft.openTurn -= 1;
    return;
  }
  const before = draft.messages[index - 1];
  if (draft.openTurn === -1 && index === draft.messages.length && before?.kind === "turn" && before.outcome === undefined) {
    draft.openTurn = index - 1;
    draft.turn = null;
  }
}
