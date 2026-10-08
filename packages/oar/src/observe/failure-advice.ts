import type { FailureClass } from "../contracts/session.js";

/**
 * One policy for a failed turn (or a `RuntimeFailureError` at open), so every
 * host decides the same way:
 * - `retry: "now"`: try again with ordinary backoff (seconds to minutes);
 * - `retry: "later"`: wait for a limit to reset, typically hours;
 * - `retry: "no"`: the same request will fail the same way.
 * `userAction`: a person has to act first (sign in, pay, pick another model,
 * shorten the input).
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

/** How to react to a failure of class `failure`. */
export function failureAdvice(failure: FailureClass): FailureAdvice {
  return ADVICE[failure];
}
