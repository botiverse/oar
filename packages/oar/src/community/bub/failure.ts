import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import type { AcpFailureReader, AcpOpenFailureReader } from "../../shared/acp/failure.js";
import { classifyFailure, failureFromErrorBody, failureFromStatus } from "../../shared/failure-class.js";
import { asRecord } from "../../shared/json.js";

/*
 * Bub's ACP server answers every failure as -32603 "Internal error" and puts
 * its own words in `data.details` (bub-acp-server 0.1.0, probed 2026-11-27):
 * - a provider's HTTP error, from Republic's APIStatusError:
 *   "Provider returned HTTP 401: {\"error\":{...}}"
 * - a refused setting: "invalid value for ACP config option model: deepseek:nope"
 */

const PROVIDER_STATUS = /^Provider returned HTTP (?<status>\d{3}): (?<body>[\s\S]*)$/u;
const INVALID_MODEL = "invalid value for ACP config option model: ";

/** The `data.details` text of a Bub RPC error, or null. */
export function bubErrorDetails(error: unknown): string | null {
  if (!(error instanceof Error) || !("data" in error)) { return null; }
  const details = asRecord(error.data)?.details;
  return typeof details === "string" && details.length > 0 ? details : null;
}

/**
 * A prompt Bub failed: the provider's HTTP status and error body when
 * Republic reports them, else Bub's words. A 401 is `auth` whatever the body
 * calls it (DeepSeek names a bad key `invalid_request_error`); the status
 * cannot tell a missing key from a refused one.
 */
export const bubFailureOutcome: AcpFailureReader = (error) => {
  const reason = bubErrorDetails(error);
  if (reason === null) { return null; }
  const provider = PROVIDER_STATUS.exec(reason)?.groups;
  if (provider?.status === undefined) { return { kind: "failed", reason, failure: classifyFailure(reason) }; }
  const status = Number(provider.status);
  const failure = status === 401 ? "auth" : failureFromErrorBody(provider.body ?? "") ?? failureFromStatus(status);
  return { kind: "failed", reason, failure, status };
};

/** A model the session's `model` option does not list is `model_unavailable`. */
export const bubOpenFailure: AcpOpenFailureReader = (error, step) => {
  const details = bubErrorDetails(error);
  if (step !== "model" || details?.startsWith(INVALID_MODEL) !== true) { return null; }
  return new RuntimeFailureError("model_unavailable", details, { cause: error });
};
