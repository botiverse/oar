import type { RecordEnvelope, RequestBody } from "../contracts/session.js";
import type { ConversationInput } from "./conversation.js";

type InputScope = Pick<RecordEnvelope, "sessionId" | "agentPath">;

/** Explicit input IDs survive resume; a missing ID uses the request identity in its own stream. */
export function inputIdentity(at: InputScope, id: string, streamId?: string): string {
  const identity = JSON.stringify([at.sessionId, at.agentPath, id]);
  return streamId === undefined ? identity : JSON.stringify([streamId, identity]);
}

// oxlint-disable-next-line max-params -- Resolve both forms against the same lane and stream used to store them.
export function findCarriedInput(inputs: Pick<ReadonlyMap<string, ConversationInput>, "get">, at: InputScope, id: string, streamId = ""): ConversationInput | undefined {
  return inputs.get(inputIdentity(at, id)) ?? inputs.get(inputIdentity(at, id, streamId));
}

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
