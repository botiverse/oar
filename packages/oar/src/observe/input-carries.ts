import type { RequestBody } from "../contracts/session.js";
import type { ConversationInput } from "./conversation.js";

/** Claimed inputs must be withdrawn or still held in an explicitly recorded adapter queue. */
export function invalidCarriedInput(body: RequestBody, get: (inputId: string) => ConversationInput | undefined): string | undefined {
  if (body.kind !== "prompt") { return undefined; }
  return body.carries?.find((inputId) => {
    const input = get(inputId);
    const latest = input?.attempts.at(-1);
    const owner = input?.attempts.findLast(attempt => attempt.state !== "rejected");
    const held = (input?.state === "accepted" || input?.state === "rejected") && owner?.request.body.kind === "queue"
      && owner.response?.body.kind === "accepted" && owner.response.body.queued === "adapter";
    const withdrawn = input?.state === "withdrawn" && latest?.request.body.kind === "withdraw" && latest.state === "accepted";
    return inputId === body.inputId || (!held && !withdrawn);
  });
}
