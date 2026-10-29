import type { FailureClass, TurnOutcome } from "../../contracts/session.js";
import { failureFromStatus } from "../../shared/failure-class.js";
import { asNumber, asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

// Native 2.178.1 error categories precede the less specific HTTP status.
const CATEGORIES: Readonly<Partial<Record<string, FailureClass>>> = {
  quota: "quota", auth: "auth", custom_model_auth: "auth", network: "unknown",
  model_service: "provider", empty_model_response: "provider", internal: "unknown",
};

/** A successful prompt RPC can still carry a failed native task outcome. */
export function codebuddyPromptOutcome(response: JsonRecord): TurnOutcome | null {
  if (response.stopReason === "cancelled") { return { kind: "aborted" }; }
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
  const meta = asRecord(response._meta);
  const outcome = meta?.["codebuddy.ai/outcome"];
  if (response.stopReason !== "refusal" && !(typeof outcome === "string" && outcome.startsWith("FAILED"))) { return null; }
  const raw = meta?.["codebuddy.ai/errorMessage"];
  const error = typeof raw === "string" ? asRecord(parseJson(raw)) : null;
  const nested = asRecord(error?.error);
  const data = asRecord(error?.data);
  const nestedData = asRecord(nested?.data);
  const category = data?.category ?? nestedData?.category;
  const status = asNumber(data?.statusCode) ?? asNumber(nestedData?.statusCode);
  const message = error?.message ?? nested?.message;
  const fallback = typeof outcome === "string" ? outcome : String(response.stopReason);
  return {
    kind: "failed", failure: (typeof category === "string" ? CATEGORIES[category] : undefined)
      ?? (status === null ? "unknown" : failureFromStatus(status)),
    reason: typeof message === "string" ? message : fallback,
    ...(status === null ? {} : { status }),
  };
}
