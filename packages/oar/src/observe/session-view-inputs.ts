import type { Event } from "../contracts/session.js";
import { awaitsEcho } from "./input-delivery.js";
import type { ConversationInput, ConversationState } from "./conversation.js";
import { removeEmptyTurn, sealTurn, type Draft } from "./session-view-fold.js";

/**
 * Where a user input enters the session view: the INPUT rule in the
 * `session-view.ts` header (issue #82), applied per input update.
 */

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

/** Queue evidence arms attribution; only an actual conflicting turn defers a placed input. */
export function foldInputUpdate(draft: Draft, input: ConversationInput, conversation: ConversationState): void {
  if (input.state === "dropped") {
    const request = input.attempts.at(-1)?.request;
    if (request?.body.kind === "prompt") { removeEmptyTurn(draft, request.id); }
  }
  const wait = awaitsEcho(input, conversation);
  upsertInput(draft, input, input.turn?.state === "queued" ? wait && draft.pendingInputs.some((pending) => pending.id === input.id) : wait);
}

/** Split a provisional prompt only when native activity actually belongs to another turn. */
export function deferWaitingInputs(draft: Draft, event: Event, conversation: ConversationState): void {
  if (event.kind !== "turn_active" || event.sessionId !== draft.rootSessionId || event.agentPath.length > 0) { return; }
  for (const input of conversation.inputs.values()) {
    const request = input.attempts.at(-1)?.request;
    if (input.turn?.state !== "queued" || input.inputId === event.inputId
      || request?.sessionId !== event.sessionId || request.agentPath.length > 0) { continue; }
    if (request.body.kind === "prompt") { removeEmptyTurn(draft, request.id); }
    sealTurn(draft);
    upsertInput(draft, input, true);
  }
}

export function turnOpenedBy(event: Event, conversation: ConversationState): string | undefined {
  const input = event.kind === "turn_active" && event.inputId !== undefined
    ? conversation.inputs.get(JSON.stringify([event.sessionId, event.agentPath, event.inputId])) : undefined;
  const request = input?.turn?.state === "active" ? input.attempts.at(-1)?.request : undefined;
  return request?.body.kind === "prompt" ? request.id : undefined;
}
