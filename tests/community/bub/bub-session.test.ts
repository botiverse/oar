import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RequestError } from "../../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { expect, test } from "vitest";
import { ModelConfirmationError } from "../../../packages/oar/src/contracts/model-confirmation-error.js";
import { RuntimeFailureError } from "../../../packages/oar/src/contracts/runtime-failure-error.js";
import { UnsupportedOptionError } from "../../../packages/oar/src/contracts/errors.js";
import { createBubRuntime } from "../../../packages/oar/src/community/bub/index.js";
import { bubErrorDetails, bubFailureOutcome, bubOpenFailure } from "../../../packages/oar/src/community/bub/failure.js";
import { bubInstallMethod } from "../../../packages/oar/src/community/bub/install.js";
import { readBubVersion } from "../../../packages/oar/src/community/bub/installation.js";
import { bubConfigureModel } from "../../../packages/oar/src/community/bub/model.js";
import { bubAcpProfile } from "../../../packages/oar/src/community/bub/session.js";
import { scriptInstallPlanOn } from "../../../packages/oar/src/shared/install.js";
import type { JsonRecord } from "../../../packages/oar/src/shared/json.js";

// Shapes below are from bub 0.6.3.dev1 with bub-acp-server 0.1.0 (experiments/bub-acp-probe.ts).

const internal = (details: string) => new RequestError(-32_603, "Internal error", { details });

test("the version reader takes `bub <version>`, development builds included", () => {
  assert.equal(readBubVersion("bub 0.6.3.dev1+gb2e54493a\n"), "0.6.3.dev1+gb2e54493a");
  assert.equal(readBubVersion("bub 0.6.2"), "0.6.2");
  assert.equal(readBubVersion("Bub version 0.6.2"), undefined);
});

test("the install runs Bub's documented line with the acp preset, which never prompts", () => {
  const plan = scriptInstallPlanOn(bubInstallMethod, { platform: "linux", arch: "x64", locate: (tool) => `/usr/bin/${tool}`, unwritable: () => null });
  assert.deepEqual(plan.kind === "plan" ? [plan.steps.map((step) => step.display), plan.source] : plan, [
    ["curl -fsSL https://bub.build/install.sh | bash -s -- --preset acp"],
    "https://bub.build",
  ]);
});

test("launchArgs are refused: bub acp takes only transport and protocol flags", () => {
  expect(() => { bubAcpProfile.validateOptions?.({ cwd: "/w", launchArgs: ["--transport", "http"] }); }).toThrow(UnsupportedOptionError);
  bubAcpProfile.validateOptions?.({ cwd: "/w", env: { BUB_HOME: "/h" } });
});

test("a provider's HTTP status classifies the turn, and 401 is auth whatever the body calls it", () => {
  const body = JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****0000 is invalid", type: "authentication_error", code: "invalid_request_error" } });
  expect(bubFailureOutcome(internal(`Provider returned HTTP 401: ${body}`), [])).toMatchObject({ kind: "failed", failure: "auth", status: 401 });
  expect(bubFailureOutcome(internal(`Provider returned HTTP 429: ${JSON.stringify({ error: { code: "insufficient_quota" } })}`), [])).toMatchObject({ failure: "quota", status: 429 });
  expect(bubFailureOutcome(internal("Provider returned HTTP 429: slow down"), [])).toMatchObject({ failure: "rate_limited", status: 429 });
  expect(bubFailureOutcome(internal("Provider returned HTTP 503: unavailable"), [])).toMatchObject({ failure: "overloaded", status: 503 });
});

test("Bub's words are the reason when no HTTP status is reported; an error without details is left to the generic rules", () => {
  const outcome = bubFailureOutcome(internal("Connection error: rate limit reached"), []);
  expect(outcome).toMatchObject({ failure: "rate_limited", reason: "Connection error: rate limit reached" });
  assert.equal(outcome !== null && "status" in outcome, false);
  assert.equal(bubFailureOutcome(new RequestError(-32_603, "Internal error"), []), null);
  assert.equal(bubFailureOutcome(new Error("x"), []), null);
  assert.equal(bubErrorDetails(new RequestError(-32_603, "Internal error", { details: 3 })), null);
});

test("an unlisted model is model_unavailable, only at the model step", () => {
  const refused = internal("invalid value for ACP config option model: deepseek:nope");
  const failure = bubOpenFailure(refused, "model");
  assert.ok(failure instanceof RuntimeFailureError);
  assert.equal(failure.failure, "model_unavailable");
  assert.equal(bubOpenFailure(refused, "open"), null);
  assert.equal(bubOpenFailure(internal("invalid value for ACP config option reasoning_effort: bogus"), "model"), null);
});

const answer = (value: string): JsonRecord => ({ configOptions: [{ id: "model", category: "model", currentValue: value }] });

test("a model must be confirmed by the option's currentValue, and effort follows the model's answer", async () => {
  const efforts: [string, JsonRecord | undefined][] = [];
  const setEffort = async (effort: string, response: JsonRecord | undefined) => { efforts.push([effort, response]); return {}; };
  const applied = await bubConfigureModel({ options: { cwd: "/", model: "deepseek:deepseek-v4-pro", effort: "high" }, response: {}, setModel: async (model) => answer(model), setEffort });
  assert.deepEqual(applied, answer("deepseek:deepseek-v4-pro"));
  assert.deepEqual(efforts, [["high", answer("deepseek:deepseek-v4-pro")]]);
  const stale = bubConfigureModel({ options: { cwd: "/", model: "b" }, response: {}, setModel: async () => answer("a"), setEffort });
  await expect(stale).rejects.toBeInstanceOf(ModelConfirmationError);
  await expect(stale).rejects.toMatchObject({ requested: "b", reported: "a" });
});

test("a resume is confirmed against Bub's session index, and dispose only detaches", () => {
  assert.equal(bubAcpProfile.resumeKeepsSessionCwd, true);
  assert.equal(bubAcpProfile.detachOnDispose, true);
  expect(bubAcpProfile.promptTokenUsage?.({ stopReason: "end_turn", usage: { totalTokens: 3195, inputTokens: 3002, outputTokens: 193 } }, {})).toEqual({ input: 3002, output: 193 });
});

test("the brand is the distributed asset, inline", () => {
  const { brand } = createBubRuntime();
  assert.ok(brand.icon?.startsWith("data:image/svg+xml,") === true);
  const svg = decodeURIComponent(brand.icon.slice("data:image/svg+xml,".length));
  assert.equal(svg, readFileSync(new URL("../../../packages/oar/assets/brands/bub.svg", import.meta.url), "utf8"));
  assert.doesNotMatch(svg, /currentColor|<script|<foreignObject|\son\w+=|(?:href|src)=/iu);
});
