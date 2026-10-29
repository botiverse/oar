import type { RejectionCode, RequestRecord, ResponseRecord } from "./records.js";

/** Both records a control call produced: the request (its `seq` is where the action sits in the stream) and the accept/reject response. What an adapter returns (the SPI face). */
export interface ControlResult {
  readonly request: RequestRecord;
  readonly response: ResponseRecord;
}

/**
 * What `Session.prompt / steer / queue / withdraw / abort` return (the API face): the
 * answer read off the two records, with the records still underneath. A
 * consumer branches on `kind` (two cases, not the four a response body can
 * carry) and on the typed `code`; `seq` is the request's position in the
 * stream, what `awaitTurnEnd` takes. `request` / `response` remain for
 * consumers who want the stream's own word (`native`, the exact records).
 */
export type ControlOutcome =
  | (ControlResult & { readonly kind: "accepted"; readonly seq: number; readonly requestId: string })
  | (ControlResult & { readonly kind: "rejected"; readonly seq: number; readonly requestId: string; readonly code: RejectionCode; readonly reason: string });
