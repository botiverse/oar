import type { TurnOutcome } from "../../contracts/session.js";
import { failureFromErrorBody, failureFromStatus } from "../../shared/failure-class.js";

/*
 * A failed pi run, classified from its assistant message's `errorMessage`
 * (docs/spec/runtime-matrix.md#pi), observed on SDK 1.0.4 against a scripted
 * Anthropic provider: "<status> <the provider's JSON body>", or inside a
 * stream the body alone. pi-ai's own `isContextOverflow` decides an oversized
 * context (`overflow`); then the body's code or type; then the status.
 */

/** The provider failure pi reported for a run. */
export interface PiProviderError {
  readonly message: string;
  /** pi-ai's `isContextOverflow` on the message that carried it. */
  readonly overflow: boolean;
}

/** Classify the run pi failed with `error`. */
export function piFailure(error: PiProviderError): Extract<TurnOutcome, { kind: "failed" }> {
  const { message, overflow } = error;
  const prefixed = /^(?<status>\d{3}) (?<body>[\s\S]*)$/u.exec(message);
  const status = prefixed?.groups?.status === undefined ? null : Number(prefixed.groups.status);
  const body = prefixed?.groups?.body ?? message;
  const withStatus = status === null ? {} : { status };
  if (overflow) {
    return { kind: "failed", reason: message, failure: "input_too_large", ...withStatus };
  }
  const named = failureFromErrorBody(body);
  if (named !== null) {
    return { kind: "failed", reason: message, failure: named, ...withStatus };
  }
  return { kind: "failed", reason: message, failure: status === null ? "unknown" : failureFromStatus(status), ...withStatus };
}
