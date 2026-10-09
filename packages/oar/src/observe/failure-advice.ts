import type { FailureClass } from "../contracts/session.js";

/**
 * Recovery timing for a failed turn (or a `RuntimeFailureError` at open),
 * based only on its failure class:
 * - `retry: "now"`: try again with ordinary backoff (seconds to minutes);
 * - `retry: "later"`: wait for a limit to reset, typically hours (`quota`,
 *   whose `resetsAt` says when where the runtime reports it; a time already
 *   past means unknown);
 * - `retry: "no"`: the same request will fail the same way.
 * `userAction`: a person has to act first (sign in, pay, pick another model,
 * shorten the input).
 * This says when another attempt may recover, not whether replaying input
 * is safe: tools may already have run or files changed. The host decides
 * whether to resend from `ConversationInput.state`, a dropped input's
 * `reason`, and records observed after reopening. Even `runtime_exited`
 * means no input echo was observed, not proof the runtime never read it.
 */
export interface FailureAdvice {
  readonly retry: "now" | "later" | "no";
  readonly userAction: boolean;
}

const ADVICE: Readonly<Record<FailureClass, FailureAdvice>> = {
  auth: { retry: "no", userAction: true },
  billing: { retry: "no", userAction: true },
  model_unavailable: { retry: "no", userAction: true },
  input_too_large: { retry: "no", userAction: true },
  rate_limited: { retry: "now", userAction: false },
  overloaded: { retry: "now", userAction: false },
  provider: { retry: "now", userAction: false },
  runtime_exited: { retry: "now", userAction: false },
  quota: { retry: "later", userAction: false },
  invalid_request: { retry: "no", userAction: false },
  unknown: { retry: "no", userAction: false },
};

/** Recovery timing for `failure`; no guarantee that replaying a turn is safe. */
export function failureAdvice(failure: FailureClass): FailureAdvice {
  return ADVICE[failure];
}
