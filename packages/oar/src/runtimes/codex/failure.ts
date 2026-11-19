import type { FailedTurn } from "../../contracts/session.js";
import { failureFromErrorBody, failureFromStatus, type Classified } from "../../shared/failure-class.js";
import { asNumber, asRecord, parseJson } from "../../shared/json.js";
import { utcInstantFromDate } from "../../shared/instant.js";

/*
 * A failed codex turn, classified from its `turn.error.codexErrorInfo`
 * (docs/spec/runtime-matrix.md#failure-evidence): a named value, or a
 * transport variant carrying the HTTP status. `other` (an HTTP 400 codex does
 * not name) carries the provider's JSON body as its message, read for its
 * code. A usage limit and an exhausted credit balance share `usageLimitExceeded`
 * (`quota`). Unmapped schema variants (`badRequest`, `sessionBudgetExceeded`,
 * `cyberPolicy`, ...) stay `unknown`.
 */

const NAMED: Readonly<Partial<Record<string, Classified["failure"]>>> = {
  unauthorized: "auth", // [schema] 0.167.0 generated protocol (experiments/codex-projection/README.md)
  modelNotFound: "model_unavailable", // [env] 0.165.0 (failure-classes.vendor.test.ts)
  usageLimitExceeded: "quota", // [env] 0.160.1 (failure-classes.vendor.test.ts)
  rateLimitExceeded: "rate_limited", // [env] 0.160.1 (failure-classes.vendor.test.ts)
  serverOverloaded: "overloaded", // [env] 0.160.1 (failure-classes.vendor.test.ts)
  internalServerError: "provider", // [env] 0.160.1 (failure-classes.vendor.test.ts)
  contextWindowExceeded: "input_too_large", // [env] 0.160.1 (failure-classes.vendor.test.ts)
};

// [env] 0.160.1 + [schema] generated protocol transport variants carrying httpStatusCode.
const TRANSPORT = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"] as const;

/** What `codexErrorInfo` says: a class, and the HTTP status a transport variant carries. */
function fromInfo(info: unknown, message: string): Classified {
  if (typeof info === "string") {
    const named = Object.hasOwn(NAMED, info) ? NAMED[info] : undefined;
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
export function codexFailure(reason: string, turnError: unknown): FailedTurn {
  const error = asRecord(turnError);
  const message = typeof error?.message === "string" ? error.message : "";
  // Native 0.169.0 prefixes remote-compaction HTTP bodies with this exact envelope.
  // Parse only the remaining JSON, never the usage-limit sentence or its local time.
  const prefix = "Error running remote compact task: ";
  const body = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  const classified = fromInfo(error?.codexErrorInfo, body);
  if (error?.codexErrorInfo === "other" && classified.failure === "quota") {
    const provider = asRecord(asRecord(parseJson(body))?.error);
    const seconds = asNumber(provider?.resets_at);
    const resetsAt = seconds === null ? null : utcInstantFromDate(new Date(seconds * 1000));
    if (resetsAt !== null) { return { kind: "failed", reason, failure: "quota", resetsAt }; }
  }
  return { kind: "failed", reason, ...classified };
}
