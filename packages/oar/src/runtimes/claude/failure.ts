import type { UtcInstant } from "../../contracts/account-usage.js";
import type { TurnOutcome } from "../../contracts/session.js";
import { anthropicLimitText, failureFromStatus, type Classified } from "../../shared/failure-class.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, type JsonRecord } from "../../shared/json.js";

/*
 * A failed claude turn, classified from what claude says
 * (docs/spec/runtime-matrix.md#claude): the category on the turn's error
 * `assistant` frame (`error`), then the result's `terminal_reason` and
 * `api_error_status`. Observed on 2.1.292 against a scripted provider. The
 * declared categories no run produced (`oauth_org_not_allowed`,
 * `account_on_hold`, `verification_required`, `overloaded`,
 * `max_output_tokens`, `cloud_credential_error`) fall through to the status.
 */

/** The categories observed, by what they mean; `server_error` is decided by its status (a 529 is overload). */
const CATEGORIES: Readonly<Partial<Record<string, Classified["failure"]>>> = {
  authentication_failed: "auth",
  model_not_found: "model_unavailable",
  rate_limit: "rate_limited",
  billing_error: "billing",
  invalid_request: "invalid_request",
};

/** What claude's error frames say about one failed turn. */
export interface ClaudeFailureFacts {
  /** The `error` of the turn's last root `assistant` frame. */
  readonly category: string | null;
  /** The result's `api_error_status`: the HTTP status, null when no request was sent. */
  readonly status: number | null;
  /** The result's `terminal_reason`. */
  readonly terminalReason: string | null;
  /** The reset of the limit claude's latest `rate_limit_event` says refuses requests (`claudeLimitReset`); null when it refuses none. */
  readonly limitResetsAt: UtcInstant | null;
}

/**
 * When the subscription limit claude reports refusing requests resets: a
 * `rate_limit_event`'s `rate_limit_info` (Agent SDK 0.3.295
 * `SDKRateLimitInfo`, [sym] 2.1.289) with `status: "rejected"` and its
 * `resetsAt`, unix seconds. claude sends one whenever its view of the
 * limits changes, a refused request (a 429 carrying the
 * `anthropic-ratelimit-unified-*` headers) included, before that request's
 * error frame and the turn's `result`; an unchanged rejection need not be
 * sent again, so the latest event stands until another replaces it. Null
 * when the limit refuses nothing (`allowed`, `allowed_warning`), when paid
 * overage still takes the requests (`overageStatus` allowed or
 * allowed_warning), or when the event names no reset. `overageResetsAt` is
 * not read. Read from the types and the binary, not observed: a run needs
 * a claude.ai subscription at its limit.
 */
export function claudeLimitReset(info: JsonRecord | null): UtcInstant | null {
  if (info?.status !== "rejected" || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning") {
    return null;
  }
  const seconds = asNumber(info.resetsAt);
  return seconds === null ? null : utcInstantFromDate(new Date(seconds * 1000));
}

/** Classify a failed claude turn whose `result` says `reason`. */
export function claudeFailure(reason: string, facts: ClaudeFailureFacts): Extract<TurnOutcome, { kind: "failed" }> {
  const { category, status, terminalReason, limitResetsAt } = facts;
  const withStatus = status === null ? {} : { status };
  const failed = (failure: Classified["failure"], extra: Omit<Classified, "failure"> & { readonly resetsAt?: UtcInstant } = {}): Extract<TurnOutcome, { kind: "failed" }> =>
    ({ kind: "failed", reason, failure, ...withStatus, ...extra });
  if (terminalReason === "prompt_too_long") {
    return failed("input_too_large");
  }
  if (category === "authentication_failed") {
    // No request sent: no credential at all ("Not logged in"). A 401: refused.
    if (status === null) { return failed("auth", { credential: "missing" }); }
    return failed("auth", status === 401 ? { credential: "rejected" } : {});
  }
  const named = category === null ? undefined : CATEGORIES[category];
  if (named !== undefined) {
    // claude's own word that a limit refused the turn: it carries the reset the latest rate_limit_event reports.
    return failed(named, category === "rate_limit" && limitResetsAt !== null ? { resetsAt: limitResetsAt } : {});
  }
  if (status === null) {
    return failed("unknown");
  }
  // A 400 with no category of its own: Anthropic's spend limit says so only in words.
  return failed(status === 400 ? anthropicLimitText(reason) ?? "invalid_request" : failureFromStatus(status));
}
