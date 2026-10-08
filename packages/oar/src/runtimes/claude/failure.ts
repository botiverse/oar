import type { TurnOutcome } from "../../contracts/session.js";
import { anthropicLimitText, failureFromStatus, type Classified } from "../../shared/failure-class.js";

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
}

/** Classify a failed claude turn whose `result` says `reason`. */
export function claudeFailure(reason: string, facts: ClaudeFailureFacts): Extract<TurnOutcome, { kind: "failed" }> {
  const { category, status, terminalReason } = facts;
  const withStatus = status === null ? {} : { status };
  const failed = (failure: Classified["failure"], extra: Omit<Classified, "failure"> = {}): Extract<TurnOutcome, { kind: "failed" }> =>
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
    return failed(named);
  }
  if (status === null) {
    return failed("unknown");
  }
  // A 400 with no category of its own: Anthropic's spend limit says so only in words.
  return failed(status === 400 ? anthropicLimitText(reason) ?? "invalid_request" : failureFromStatus(status));
}
