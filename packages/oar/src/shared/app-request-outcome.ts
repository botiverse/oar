import type { AnswerOutcome, AnswerRejectionCode } from "../contracts/answer.js";
import type { RequestRecord, ResponseRecord } from "../contracts/records.js";

/**
 * The correlation and refusal face of an answer (docs/spec/app-requests.md):
 * pure constructors over the request and response records, so the
 * coordinator and any adapter report an outcome the same way. Kept apart
 * from the coordinator's stateful part; nothing here reads a clock, a
 * transport or a pending flag.
 */
export interface AnswerCorrelation {
  readonly requestId: string;
  /** The `toApp` request record; absent only when no record of this stream carries the id. */
  readonly request?: RequestRecord;
  /** The `answered` response record; absent when the answer was refused before anything was written. */
  readonly response?: ResponseRecord;
  /** The request record's position in the stream, `-1` when no record carries the id. */
  readonly seq: number;
}

export function correlation(requestId: string, request: RequestRecord | undefined, response?: ResponseRecord): AnswerCorrelation {
  return {
    requestId,
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
    seq: request?.seq ?? -1,
  };
}

export function answerRefusal(requestId: string, code: AnswerRejectionCode, reason: string, request?: RequestRecord, response?: ResponseRecord): AnswerOutcome {
  return { ...correlation(requestId, request, response), kind: "rejected", code, reason };
}

export function answerAborted(request: RequestRecord, code: Extract<AnswerOutcome, { readonly kind: "aborted" }>["code"], reason: string): AnswerOutcome {
  return { ...correlation(request.id, request), kind: "aborted", code, reason };
}
