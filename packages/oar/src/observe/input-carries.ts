import type { RequestBody } from "../contracts/session.js";
import type { ConversationInput } from "./conversation.js";

/** All claimed inputs must still belong to the caller after an accepted withdraw. */
export function invalidCarriedInput(body: RequestBody, get: (inputId: string) => ConversationInput | undefined): string | undefined {
  if (body.kind !== "prompt") { return undefined; }
  return body.carries?.find((inputId) => {
    const input = get(inputId);
    const latest = input?.attempts.at(-1);
    return inputId === body.inputId || input?.state !== "withdrawn"
      || latest?.request.body.kind !== "withdraw" || latest.state !== "accepted";
  });
}
