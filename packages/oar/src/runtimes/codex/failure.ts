import type { TurnOutcome } from "../../contracts/session.js";
import { failureFromErrorBody, failureFromStatus, type Classified } from "../../shared/failure-class.js";
import { asNumber, asRecord } from "../../shared/json.js";

/*
 * A failed codex turn, classified from its `turn.error.codexErrorInfo`
 * (docs/spec/runtime-matrix.md#codex), observed on 0.160.1 against a scripted
 * provider: a named value, or a transport variant carrying the HTTP status.
 * `other` (an HTTP 400 codex does not name) carries the provider's JSON body
 * as its message, read for its code. A usage limit and an exhausted credit
 * balance are the same `usageLimitExceeded`, so both are `quota`. Declared
 * values no run produced (`unauthorized`, `badRequest`,
 * `sessionBudgetExceeded`, `cyberPolicy`, …) stay `unknown`.
 */

const NAMED: Readonly<Partial<Record<string, Classified["failure"]>>> = {
  usageLimitExceeded: "quota",
  rateLimitExceeded: "rate_limited",
  serverOverloaded: "overloaded",
  internalServerError: "provider",
  contextWindowExceeded: "input_too_large",
};

const TRANSPORT = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"] as const;

/** What `codexErrorInfo` says: a class, and the HTTP status a transport variant carries. */
function fromInfo(info: unknown, message: string): Classified {
  if (typeof info === "string") {
    const named = NAMED[info];
    if (named !== undefined) { return { failure: named }; }
    return { failure: info === "other" ? failureFromErrorBody(message) ?? "unknown" : "unknown" };
  }
  const record = asRecord(info);
  for (const variant of TRANSPORT) {
    const status = asNumber(asRecord(record?.[variant])?.httpStatusCode);
    if (status !== null) {
      return { failure: failureFromStatus(status), status };
    }
  }
  return { failure: "unknown" };
}

/** Classify a failed codex turn whose reason is `reason`, from its `turn.error`. */
export function codexFailure(reason: string, turnError: unknown): Extract<TurnOutcome, { kind: "failed" }> {
  const error = asRecord(turnError);
  const message = typeof error?.message === "string" ? error.message : "";
  return { kind: "failed", reason, ...fromInfo(error?.codexErrorInfo, message) };
}
