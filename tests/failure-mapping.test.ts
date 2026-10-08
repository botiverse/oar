import { RequestError } from "../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { expect, test } from "vitest";
import { RuntimeFailureError } from "../packages/oar/src/contracts/runtime-failure-error.js";
import type { FrameBody } from "../packages/oar/src/contracts/session.js";
import { claudeFailure } from "../packages/oar/src/runtimes/claude/failure.js";
import { codexFailure } from "../packages/oar/src/runtimes/codex/failure.js";
import { cursorOpenFailure } from "../packages/oar/src/runtimes/cursor/failure.js";
import { grokFailureOutcome } from "../packages/oar/src/runtimes/grok/failure.js";
import { piFailure } from "../packages/oar/src/runtimes/pi/failure.js";
import { acpFailureOutcome, acpOpenFailure } from "../packages/oar/src/shared/acp/failure.js";

/*
 * Each adapter's mapping, on the facts the evidence runs observed
 * (docs/spec/runtime-matrix.md#failure-evidence, experiments/failure-evidence.ts);
 * the vendor tests pin that the runtimes still say them.
 */

// claude 2.1.292: the assistant frame's `error`, the result's `api_error_status` and `terminal_reason`.
test.each([
  { name: "missing login", reason: "Not logged in · Please run /login", category: "authentication_failed", status: null, terminalReason: "api_error", expected: { failure: "auth", credential: "missing" } },
  { name: "invalid key", reason: "Invalid API key · Fix external API key", category: "authentication_failed", status: 401, terminalReason: "api_error", expected: { failure: "auth", credential: "rejected", status: 401 } },
  { name: "unknown model", reason: "There's an issue with the selected model", category: "model_not_found", status: 404, terminalReason: "api_error", expected: { failure: "model_unavailable", status: 404 } },
  { name: "rate limited", reason: "API Error: Request rejected (429)", category: "rate_limit", status: 429, terminalReason: "api_error", expected: { failure: "rate_limited", status: 429 } },
  { name: "spend limit", reason: "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.", category: "unknown", status: 400, terminalReason: "api_error", expected: { failure: "quota", status: 400 } },
  { name: "credit balance", reason: "Credit balance is too low", category: "billing_error", status: 400, terminalReason: "api_error", expected: { failure: "billing", status: 400 } },
  { name: "402", reason: "API Error: 402 This organization has a billing issue.", category: "unknown", status: 402, terminalReason: "api_error", expected: { failure: "billing", status: 402 } },
  { name: "500", reason: "API Error: 500 Internal server error.", category: "server_error", status: 500, terminalReason: "api_error", expected: { failure: "provider", status: 500 } },
  { name: "529", reason: "API Error: 529 Overloaded.", category: "server_error", status: 529, terminalReason: "api_error", expected: { failure: "overloaded", status: 529 } },
  { name: "oversized context", reason: "Prompt is too long", category: "invalid_request", status: 400, terminalReason: "prompt_too_long", expected: { failure: "input_too_large", status: 400 } },
  { name: "an invalid request", reason: "API Error: 400 max_tokens exceeds model limit", category: "invalid_request", status: 400, terminalReason: "api_error", expected: { failure: "invalid_request", status: 400 } },
  { name: "a declared category no run produced", reason: "Your account is on hold", category: "account_on_hold", status: 403, terminalReason: "api_error", expected: { failure: "unknown", status: 403 } },
  { name: "no category and no status", reason: "error", category: null, status: null, terminalReason: null, expected: { failure: "unknown" } },
] as const)("claude: $name", ({ reason, category, status, terminalReason, expected }) => {
  expect(claudeFailure(reason, { category, status, terminalReason })).toEqual({ kind: "failed", reason, ...expected });
});

// codex 0.160.1: `turn.error.codexErrorInfo`.
test.each([
  { name: "missing login or invalid key", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, message: "", expected: { failure: "auth", status: 401 } },
  { name: "unknown model", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } }, message: "", expected: { failure: "model_unavailable", status: 404 } },
  { name: "rate limited", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, message: "", expected: { failure: "rate_limited", status: 429 } },
  { name: "usage limit or billing", codexErrorInfo: "usageLimitExceeded", message: "Quota exceeded. Check your plan and billing details.", expected: { failure: "quota" } },
  { name: "rate limited in the stream", codexErrorInfo: "rateLimitExceeded", message: "", expected: { failure: "rate_limited" } },
  { name: "server error", codexErrorInfo: "internalServerError", message: "", expected: { failure: "provider" } },
  { name: "overloaded", codexErrorInfo: "serverOverloaded", message: "Selected model is at capacity.", expected: { failure: "overloaded" } },
  { name: "oversized context in the stream", codexErrorInfo: "contextWindowExceeded", message: "", expected: { failure: "input_too_large" } },
  { name: "oversized context as an HTTP 400", codexErrorInfo: "other", message: '{"error":{"message":"Your input exceeds the context window of this model.","type":"invalid_request_error","param":null,"code":"context_length_exceeded"}}', expected: { failure: "input_too_large" } },
  { name: "other with words only", codexErrorInfo: "other", message: "something broke", expected: { failure: "unknown" } },
  { name: "a declared value no run produced", codexErrorInfo: "unauthorized", message: "", expected: { failure: "unknown" } },
  { name: "a disconnect without a status", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, message: "", expected: { failure: "unknown" } },
] as const)("codex: $name", ({ codexErrorInfo, message, expected }) => {
  expect(codexFailure("failed: x", { message, codexErrorInfo })).toEqual({ kind: "failed", reason: "failed: x", ...expected });
});

// pi SDK 1.0.4: `errorMessage` is "<status> <provider JSON>", or the JSON alone inside a stream.
test.each([
  { name: "invalid key", message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', overflow: false, expected: { failure: "auth", status: 401 } },
  { name: "unentitled model", message: '404 {"type":"error","error":{"type":"not_found_error","message":"model: oar-missing-model"}}', overflow: false, expected: { failure: "model_unavailable", status: 404 } },
  { name: "rate limited", message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}', overflow: false, expected: { failure: "rate_limited", status: 429 } },
  { name: "spend limit", message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}', overflow: false, expected: { failure: "quota", status: 400 } },
  { name: "credit balance", message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', overflow: false, expected: { failure: "billing", status: 400 } },
  { name: "402", message: '402 {"type":"error","error":{"type":"billing_error","message":"This organization has a billing issue."}}', overflow: false, expected: { failure: "billing", status: 402 } },
  { name: "500", message: '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', overflow: false, expected: { failure: "provider", status: 500 } },
  { name: "529", message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', overflow: false, expected: { failure: "overloaded", status: 529 } },
  { name: "oversized context (pi-ai's isContextOverflow)", message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}', overflow: true, expected: { failure: "input_too_large", status: 400 } },
  { name: "overloaded inside the stream", message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', overflow: false, expected: { failure: "overloaded" } },
  { name: "a status and words", message: "400 bad request", overflow: false, expected: { failure: "invalid_request", status: 400 } },
  { name: "words only", message: "provider error", overflow: false, expected: { failure: "unknown" } },
] as const)("pi: $name", ({ message, overflow, expected }) => {
  expect(piFailure({ message, overflow })).toEqual({ kind: "failed", reason: message, ...expected });
});

function retryState(update: Record<string, unknown>): FrameBody {
  return { type: "_x.ai/session_notification", native: { sessionId: "s", update: { sessionUpdate: "retry_state", ...update } }, events: [] };
}

// ACP: -32000 is `RequestError.authRequired`; grok 1.0.46 adds -32003 and its retry notifications.
test("ACP: an auth-required answer is auth, and nothing says which credential problem", () => {
  expect(acpFailureOutcome(RequestError.authRequired(undefined, "401 Incorrect API key provided"))).toEqual({
    kind: "failed", reason: "Authentication required: 401 Incorrect API key provided", failure: "auth",
  });
  // Any other answer is the profile's, else its words (opencode's last resort).
  expect(acpFailureOutcome(RequestError.internalError({ errorName: "APIError" }, "Overloaded"))).toMatchObject({ failure: "overloaded" });
});

test.each([
  { name: "any 429", error: new RequestError(-32_003, "Rate limited", "API error (status 429 Too Many Requests): …"), frames: [retryState({ type: "exhausted", is_rate_limited: true })], failure: "rate_limited" },
  { name: "invalid key", error: RequestError.internalError("Unauthorized (401) …"), frames: [retryState({ type: "failed", error_type: "auth" })], failure: "auth" },
  { name: "oversized context", error: RequestError.internalError("…"), frames: [retryState({ type: "failed", error_type: "context_length" })], failure: "input_too_large" },
  { name: "unentitled model", error: RequestError.internalError("…"), frames: [retryState({ type: "retrying", error_type: "rate_limited" }), retryState({ type: "failed", error_type: "api" })], failure: "provider" },
] as const)("grok: $name", ({ error, frames, failure }) => {
  expect(acpFailureOutcome(error, frames, grokFailureOutcome)).toMatchObject({ kind: "failed", failure });
});

test("grok: a failure with no final retry_state falls to the generic rules", () => {
  expect(grokFailureOutcome(RequestError.internalError("x"), [retryState({ type: "retrying", error_type: "api" })])).toBeNull();
});

test("ACP open: a refused login is auth; a refused model is model_unavailable only on the model call", () => {
  const login = acpOpenFailure(RequestError.authRequired({ message: "No authentication method selected." }), "open");
  expect(login).toBeInstanceOf(RuntimeFailureError);
  expect(login).toMatchObject({ failure: "auth", reason: "Authentication required" });
  expect(login).not.toHaveProperty("credential");
  const model = acpOpenFailure(RequestError.invalidParams({ modelId: "oar-missing-model" }, "model not found"), "model");
  expect(model).toMatchObject({ name: "RuntimeFailureError", failure: "model_unavailable" });
  const params = RequestError.invalidParams(undefined, "bad cwd");
  expect(acpOpenFailure(params, "open")).toBe(params);
  const internal = RequestError.internalError({ details: "Model \"x\" is not configured in config.toml." });
  expect(acpOpenFailure(internal, "model")).toBe(internal);
});

test("cursor open: a refused key is auth, rejected, with its status", () => {
  const refused = Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", status: 401, code: "error" });
  expect(cursorOpenFailure(refused)).toMatchObject({ name: "RuntimeFailureError", failure: "auth", credential: "rejected", status: 401, reason: "Invalid User API Key" });
  const other = new Error("network down");
  expect(cursorOpenFailure(other)).toBe(other);
});
