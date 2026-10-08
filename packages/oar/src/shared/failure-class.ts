import type { CredentialProblem, FailureClass } from "../contracts/session.js";
import { asRecord, parseJson } from "./json.js";

/*
 * Failure classes from what a runtime reveals, most structured first
 * (docs/spec/runtime-matrix.md#failure-evidence): the runtime's own category
 * (each adapter maps its own), then the provider's error body (`type`,
 * `code`), then the HTTP status. Only causes some runtime was observed to
 * report are mapped; prose matching is each adapter's documented last resort.
 */

/** A failed outcome's classification: the class, and the credential problem and HTTP status where the runtime said them. */
export interface Classified {
  readonly failure: FailureClass;
  readonly credential?: CredentialProblem;
  readonly status?: number;
}

/**
 * What an HTTP status means at the providers (the Anthropic, OpenAI and
 * Gemini error references) when nothing richer says. A 401 says the
 * credential failed, not whether it was missing or refused; a 400 is any
 * rejected request.
 */
export function failureFromStatus(status: number): FailureClass {
  switch (status) {
    case 400: return "invalid_request";
    case 401: return "auth";
    case 402: return "billing";
    case 404: return "model_unavailable";
    case 429: return "rate_limited";
    case 503:
    case 529: return "overloaded";
    default: return status >= 500 && status < 600 ? "provider" : "unknown";
  }
}

/**
 * Provider error `code`s and `type`s some runtime was observed to carry:
 * OpenAI's codes (and its ChatGPT backend's `usage_limit_reached`,
 * `usage_not_included`), Anthropic's types. An OpenAI 429 is a quota or a
 * billing failure when its code says so, throttling only when it does not.
 */
const ERROR_CODES: Readonly<Partial<Record<string, FailureClass>>> = {
  invalid_api_key: "auth",
  model_not_found: "model_unavailable",
  rate_limit_exceeded: "rate_limited",
  insufficient_quota: "quota",
  organization_usage_limit_exceeded: "quota",
  usage_limit_reached: "quota",
  usage_not_included: "quota",
  credit_balance_exhausted: "billing",
  context_length_exceeded: "input_too_large",
  server_is_overloaded: "overloaded",
  authentication_error: "auth",
  not_found_error: "model_unavailable",
  rate_limit_error: "rate_limited",
  billing_error: "billing",
  overloaded_error: "overloaded",
  api_error: "provider",
  server_error: "provider",
  invalid_request_error: "invalid_request",
};

/** The class a provider error code or type names; null for one no runtime was seen to carry. */
export function failureFromErrorCode(code: string): FailureClass | null {
  return ERROR_CODES[code] ?? null;
}

/**
 * Anthropic's 400s that have no type of their own (both are
 * `invalid_request_error`): an organization's spend limit and an exhausted
 * credit balance. Matched on the API's own wording, the last resort for the
 * adapters that carry Anthropic's message (claude, pi); pinned by their
 * vendor tests.
 */
export function anthropicLimitText(message: string): FailureClass | null {
  if (/credit balance is too low/iu.test(message)) {
    return "billing";
  }
  if (/reached your specified API usage limits/iu.test(message)) {
    return "quota";
  }
  return null;
}

/**
 * A provider's JSON error body, as Anthropic (`{type: "error", error: {type,
 * message}}`) and OpenAI (`{error: {code, type, message}}`) send it: the
 * class its code names, else its type's (Anthropic's 400 wording first).
 * Null when `text` is no such body or names nothing known.
 */
export function failureFromErrorBody(text: string): FailureClass | null {
  const error = asRecord(asRecord(parseJson(text))?.error);
  if (error === null) {
    return null;
  }
  const code = typeof error.code === "string" ? failureFromErrorCode(error.code) : null;
  if (code !== null) {
    return code;
  }
  const message = typeof error.message === "string" ? error.message : "";
  if (error.type === "invalid_request_error") {
    return anthropicLimitText(message) ?? "invalid_request";
  }
  return typeof error.type === "string" ? failureFromErrorCode(error.type) : null;
}

/**
 * Best-effort classification of vendor error prose: the documented last
 * resort of the adapters whose runtime reports no structure for a failure
 * (opencode's prompt errors, cursor's run errors). The patterns are pinned by
 * the vendor snapshot tests: when a runtime changes its wording, the snapshot
 * moves and this table gets a conscious update.
 */
export function classifyFailure(reason: string): FailureClass {
  if (/\b401\b|authenticat(?:e|ed|ion)|\boauth\b|unauthorized|invalid (?:user )?(?:x-)?api[- ]?key|x-api-key|log(?:ged)? ?in/iu.test(reason)) {
    return "auth";
  }
  const limit = anthropicLimitText(reason);
  if (limit !== null) {
    return limit;
  }
  if (/\b429\b|rate.?limit/iu.test(reason)) {
    return "rate_limited";
  }
  if (/quota|usage limit/iu.test(reason)) {
    return "quota";
  }
  if (/billing/iu.test(reason)) {
    return "billing";
  }
  if (/\b400\b|invalid_request|issue with the selected model|model .* (?:does not|doesn't|may not) exist|unknown model|invalid model/iu.test(reason)) {
    return "invalid_request";
  }
  if (/\b529\b|\b503\b|overloaded/iu.test(reason)) {
    return "overloaded";
  }
  if (/\b\d{3}\b|error/iu.test(reason)) {
    return "provider";
  }
  return "unknown";
}
