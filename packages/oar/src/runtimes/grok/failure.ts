import type { FailureClass, FrameBody, TurnOutcome } from "../../contracts/session.js";
import { acpErrorReason, rpcErrorCode, type AcpFailureReader } from "../../shared/acp/failure.js";
import { failureFromErrorCode, failureFromStatus } from "../../shared/failure-class.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/*
 * A prompt grok answered with an error (docs/spec/runtime-matrix.md#opencode-kimi-grok-antigravity-acp),
 * observed on 1.0.46 and 1.0.77 against a scripted provider: -32003 "Rate
 * limited" for every HTTP 429, its `data` the provider's words as
 * `API error (status 429 …): <error type>: <message>`; otherwise -32603
 * "Internal error", whose cause is the `error_type` of the `retry_state`
 * update that ended grok's retries, and whose `data.http_status` is the
 * provider's status for an API error (sampling/error.rs
 * `map_sampling_err_to_acp`, `error_data_with_status`).
 */

const RATE_LIMITED = -32_003;
/** Grok's own code for an exhausted free allowance on a 429 (sampling/error.rs `FREE_USAGE_EXHAUSTED_ERROR_CODE`). */
const FREE_USAGE_EXHAUSTED = "subscription:free-usage-exhausted";

const ERROR_TYPES: Readonly<Partial<Record<string, FailureClass>>> = {
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

/**
 * A 429 is throttling unless the provider named a spending limit: Grok's
 * free-usage code, or an error type the shared table calls `quota` or
 * `billing` (`insufficient_quota`, 1.0.77). The type is the word after
 * Grok's `API error (status …): ` prefix.
 */
function limitFailure(detail: string): FailureClass {
  if (detail.includes(FREE_USAGE_EXHAUSTED)) { return "quota"; }
  const type = /API error \(status [^)]*\): ([\w.-]+):/u.exec(detail)?.[1];
  const named = type === undefined ? null : failureFromErrorCode(type);
  return named === "quota" || named === "billing" ? named : "rate_limited";
}

/** The provider's HTTP status Grok put on an API error's `data` (-32603 only). */
function httpStatus(error: unknown): number | null {
  const status = asRecord(error instanceof Error && "data" in error ? error.data : undefined)?.http_status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export const grokFailureOutcome: AcpFailureReader = (error, frames) => {
  const reason = acpErrorReason(error);
  if (rpcErrorCode(error) === RATE_LIMITED) {
    return { kind: "failed", reason, failure: limitFailure(reason), status: 429 };
  }
  const update = finalRetryState(frames);
  const named = typeof update?.error_type === "string" ? ERROR_TYPES[update.error_type] : undefined;
  // Grok's `api` is any API error; the status it kept says which (402: billing).
  const status = httpStatus(error);
  const byStatus = status === null ? "unknown" : failureFromStatus(status);
  const failure = (named === undefined || named === "provider") && byStatus !== "unknown" ? byStatus : named;
  return failure === undefined ? null : { kind: "failed", reason, failure, ...(status === null ? {} : { status }) };
};

/** Grok validates its schema and reports either a value or a typed error field, even with end_turn. */
export function grokPromptOutcome(response: JsonRecord): TurnOutcome {
  if (response.stopReason === "cancelled") { return { kind: "aborted" }; }
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the native ACP extension envelope.
  const meta = asRecord(response._meta);
  if (typeof meta?.structuredOutputError === "string") {
    return { kind: "failed", failure: "output_schema", reason: meta.structuredOutputError };
  }
  return { kind: "completed", ...(meta !== null && Object.hasOwn(meta, "structuredOutput") ? { structuredOutput: meta.structuredOutput } : {}) };
}
