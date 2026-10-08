import { expect, test } from "vitest";
import type { FailureClass } from "../packages/oar/src/contracts/session.js";
import { failureAdvice } from "../packages/oar/src/observe/index.js";
import { anthropicLimitText, classifyFailure, failureFromErrorBody, failureFromStatus } from "../packages/oar/src/shared/failure-class.js";

// The prose last resort (opencode's prompt errors, cursor's run errors).
test.each([
  // claude 2.1.288, reported from Ferry (#70)
  ["Failed to authenticate: OAuth session expired and could not be refreshed", "auth"],
  ["Not logged in", "auth"],
  ["Invalid API key · Please run /login", "auth"],
  // @cursor/sdk 1.0.35, a run without a usable credential
  ["[unknown] Invalid User API Key", "auth"],
  // opencode 1.18.30's prompt errors carry the provider's message (docs/spec/runtime-matrix.md#failure-evidence)
  ["Internal error: x-api-key header is required", "auth"],
  ["Internal error: This request would exceed the rate limit for your organization of 50 requests per minute.", "rate_limited"],
  ["Internal error: You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.", "quota"],
  ["Internal error: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", "billing"],
  ["Internal error: This organization has a billing issue.", "billing"],
  ["Internal error: Overloaded", "overloaded"],
  ["Internal error: Internal server error", "provider"],
  ["429 rate limit exceeded", "rate_limited"],
  ["Overloaded", "overloaded"],
  ["the agent stopped", "unknown"],
] as const)("%s is classified %s", (reason, expected) => {
  expect(classifyFailure(reason)).toBe(expected);
});

test.each([
  [400, "invalid_request"], [401, "auth"], [402, "billing"], [404, "model_unavailable"], [429, "rate_limited"],
  [500, "provider"], [502, "provider"], [503, "overloaded"], [529, "overloaded"], [418, "unknown"],
] as const)("status %i means %s", (status, expected) => {
  expect(failureFromStatus(status)).toBe(expected);
});

// The bodies the scripted provider sent in the evidence runs (experiments/failure-evidence.ts).
test.each([
  ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "auth"],
  ['{"type":"error","error":{"type":"not_found_error","message":"model: oar-missing-model"}}', "model_unavailable"],
  ['{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}', "rate_limited"],
  ['{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}', "quota"],
  ['{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', "billing"],
  ['{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}', "invalid_request"],
  ['{"type":"error","error":{"type":"billing_error","message":"This organization has a billing issue."}}', "billing"],
  ['{"type":"error","error":{"type":"api_error","message":"Internal server error"}}', "provider"],
  ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
  // An OpenAI 429 is a quota or a billing failure when its code says so.
  ['{"error":{"type":"requests","code":"rate_limit_exceeded","message":"Rate limit reached"}}', "rate_limited"],
  ['{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota"}}', "quota"],
  ['{"error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"Credit balance exhausted"}}', "billing"],
  ['{"error":{"type":"requests","code":"organization_usage_limit_exceeded","message":"Organization usage limit reached"}}', "quota"],
  ['{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}', "quota"],
  ['{"error":{"message":"Your input exceeds the context window of this model.","type":"invalid_request_error","param":null,"code":"context_length_exceeded"}}', "input_too_large"],
  ['{"error":{"type":"server_error","code":"server_is_overloaded","message":"The server is overloaded or not ready yet."}}', "overloaded"],
] as const)("the error body %s names %s", (body, expected) => {
  expect(failureFromErrorBody(body)).toBe(expected);
});

test("text that is no error body names nothing", () => {
  expect(failureFromErrorBody("bad request")).toBeNull();
  expect(failureFromErrorBody('{"error":{"type":"made_up","message":"?"}}')).toBeNull();
  expect(anthropicLimitText("prompt is too long")).toBeNull();
});

const advice = {
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
} satisfies Record<FailureClass, ReturnType<typeof failureAdvice>>;

test.each(Object.entries(advice))("%s has one policy", (failure, expected) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- keys of a FailureClass-keyed table
  expect(failureAdvice(failure as FailureClass)).toEqual(expected);
});
