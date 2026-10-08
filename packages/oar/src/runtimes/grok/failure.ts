import type { FrameBody, TurnOutcome } from "../../contracts/session.js";
import { acpErrorReason, rpcErrorCode, type AcpFailureReader } from "../../shared/acp/failure.js";
import { asRecord } from "../../shared/json.js";

/*
 * A prompt grok answered with an error (docs/spec/runtime-matrix.md#opencode-kimi-grok-antigravity-acp),
 * observed on 1.0.46 against a scripted provider: -32003 "Rate limited" for
 * every 429 (throttling, a usage limit, an exhausted balance: grok's code
 * does not tell them apart); otherwise -32603 "Internal error", whose cause
 * is the `error_type` of the `retry_state` update that ended grok's retries.
 */

const RATE_LIMITED = -32_003;

const ERROR_TYPES: Readonly<Partial<Record<string, Extract<TurnOutcome, { kind: "failed" }>["failure"]>>> = {
  auth: "auth",
  rate_limited: "rate_limited",
  context_length: "input_too_large",
  api: "provider",
};

/** The last `retry_state` update that ended grok's retries (`failed` or `exhausted`). */
function finalRetryState(frames: readonly FrameBody[]): Record<string, unknown> | null {
  for (const frame of frames.toReversed()) {
    const update = frame.type === "_x.ai/session_notification" ? asRecord(asRecord(frame.native)?.update) : null;
    if (update?.sessionUpdate === "retry_state" && (update.type === "failed" || update.type === "exhausted")) {
      return update;
    }
  }
  return null;
}

export const grokFailureOutcome: AcpFailureReader = (error, frames) => {
  const reason = acpErrorReason(error);
  if (rpcErrorCode(error) === RATE_LIMITED) {
    return { kind: "failed", reason, failure: "rate_limited" };
  }
  const update = finalRetryState(frames);
  const named = typeof update?.error_type === "string" ? ERROR_TYPES[update.error_type] : undefined;
  return named === undefined ? null : { kind: "failed", reason, failure: named };
};
