import type { ConversationInput, ConversationState, InputAttempt } from "./conversation.js";

/** A drop ends ownership without changing any earlier request or response. */
export interface InputDrop {
  readonly attempts: number;
  readonly reason: "turn_interrupted" | "runtime_exited";
}

/** Only attempts after the latest withdrawal or drop can own the input again. */
export function deliveryState(attempts: readonly InputAttempt[], drop?: InputDrop): Pick<ConversationInput, "state" | "reason"> {
  const withdrawn = attempts.findLastIndex((attempt) => attempt.request.body.kind === "withdraw" && attempt.state === "accepted");
  const cut = Math.max(withdrawn, (drop?.attempts ?? 0) - 1);
  const delivery = attempts.slice(cut + 1).filter((attempt) => attempt.request.body.kind !== "withdraw");
  if (delivery.some((attempt) => attempt.state === "accepted")) { return { state: "accepted" }; }
  const last = delivery.at(-1);
  if (last !== undefined) { return { state: last.state }; }
  if (drop !== undefined && withdrawn < drop.attempts) { return { state: "dropped", reason: drop.reason }; }
  return { state: withdrawn === -1 ? "pending" : "withdrawn" };
}

/** An observed input's new control state; old drop reasons never survive a retry. */
export function withDeliveryState(input: ConversationInput, attempts: readonly InputAttempt[], drop?: InputDrop): ConversationInput {
  const { reason: _reason, ...rest } = input;
  return { ...rest, attempts, ...deliveryState(attempts, drop) };
}

/** Whether the stream has established that this input waits for a native echo. */
export function awaitsEcho(input: ConversationInput, conversation: Pick<ConversationState, "inputs">): boolean {
  if (input.observations.length > 0 || input.state === "rejected" || input.state === "withdrawn" || input.state === "dropped") { return false; }
  if (input.attempts.some((attempt) => attempt.request.body.kind === "prompt" && attempt.state !== "rejected")) { return false; }
  for (const known of conversation.inputs.values()) {
    if (known.observations.length > 0) { return true; }
  }
  return false;
}
