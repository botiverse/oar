import type { FailureClass, TurnOutcome } from "../../contracts/session.js";
import { failureFromStatus } from "../../shared/failure-class.js";
import { asNumber, asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/*
 * CodeBuddy 2.173.0 / 2.178.1 native `_meta["codebuddy.ai/errorMessage"]`
 * `data.category` values. Categories precede the less specific HTTP status:
 * - [env] auth (scripted 401 in sea-trial/vendor/codebuddy.vendor.test.ts)
 * - [sym] quota, custom_model_auth, network, model_service,
 *   empty_model_response, internal (CodeBuddy 2.173.0 binary native ACP error
 *   serializer and `FAILED_MODEL_REQUEST` / `REFUSED_OR_BLOCKED` classifier)
 */
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
  // [sym] CodeBuddy 2.173.0 maps model finish_reason `content_filter`/`refusal` to
  // bare `stopReason: "refusal"` without `errorMessage` (falls through to ACP `model_refused`).
  // Local command, pre-message compact, queue and pre-history errors all attach
  // `codebuddy.ai/errorMessage` alongside `refusal`, so presence of `errorMessage`
  // without a provider category/status stays `unknown`, never `model_refused`.
  if (response.stopReason === "refusal" && raw === undefined && !(typeof outcome === "string" && outcome.startsWith("FAILED"))) { return null; }
  const nested = asRecord(error?.error);
  const data = asRecord(error?.data);
  const nestedData = asRecord(nested?.data);
  const category = data?.category ?? nestedData?.category;
  const status = asNumber(data?.statusCode) ?? asNumber(nestedData?.statusCode);
  const message = error?.message ?? nested?.message;
  const plainRaw = typeof raw === "string" && raw.length > 0 && error === null ? raw : undefined;
  const fallback = plainRaw ?? (typeof outcome === "string" ? outcome : String(response.stopReason));
  return {
    kind: "failed", failure: (typeof category === "string" ? CATEGORIES[category] : undefined)
      ?? (status === null ? "unknown" : failureFromStatus(status)),
    reason: typeof message === "string" ? message : fallback,
    ...(status === null ? {} : { status }),
  };
}
