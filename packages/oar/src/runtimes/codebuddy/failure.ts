import type { TurnOutcome } from "../../contracts/session.js";
import { failureFromStatus } from "../../shared/failure-class.js";
import { asNumber, asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/** 2.178.1 returns a successful RPC carrying refusal + FAILED_MODEL_REQUEST
 * for an HTTP 401. Its JSON-encoded error metadata retains statusCode. */
export function codebuddyPromptOutcome(response: JsonRecord): TurnOutcome | null {
  if (response.stopReason === "cancelled") { return { kind: "aborted" }; }
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
  const meta = asRecord(response._meta);
  const outcome = meta?.["codebuddy.ai/outcome"];
  if (response.stopReason !== "refusal" && !(typeof outcome === "string" && outcome.startsWith("FAILED"))) { return null; }
  const raw = meta?.["codebuddy.ai/errorMessage"];
  const error = typeof raw === "string" ? asRecord(parseJson(raw)) : null;
  const status = asNumber(asRecord(error?.data)?.statusCode);
  return {
    kind: "failed", failure: status === null ? "unknown" : failureFromStatus(status),
    reason: "CodeBuddy refused the model request",
    ...(status === null ? {} : { status }),
  };
}
