import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { PiSessionProvider } from "../../packages/oar/src/contracts/pi-provider.js";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { checkPiCompaction, checkPiProvider, piProviderEntry, piProviderModelId, piRequestedModel } from "../../packages/oar/src/runtimes/pi/provider.js";
import { piOnlyRefusals, refuseSessionOptions } from "../../packages/oar/src/shared/session-options.js";

/** A gateway declaration shaped like a host's, with the pieces each case needs to vary. */
function gateway(overrides: Partial<PiSessionProvider> = {}): PiSessionProvider {
  return {
    id: "gateway",
    api: "openai-completions",
    baseUrl: "https://gateway.example.test/v1",
    apiKeyEnv: "GATEWAY_API_KEY",
    models: [{ id: "reasoner", contextWindow: 1_000_000, maxTokens: 65_536 }],
    ...overrides,
  };
}

test("a host-declared provider is turned into the entry Pi's model plane takes", () => {
  const entry = piProviderEntry(gateway({
    baseUrl: "https://gateway.example.test/v1/",
    models: [{
      id: "reasoner",
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text", "image"],
      name: "Reasoner",
      compat: { supportsStore: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    }],
  }));
  assert.equal(entry.api, "openai-completions");
  // A trailing slash is dropped: Pi joins the path itself.
  assert.equal(entry.baseUrl, "https://gateway.example.test/v1");
  // The NAME travels, never the secret: Pi resolves `$NAME` at request time.
  assert.equal(entry.apiKey, "$GATEWAY_API_KEY");
  assert.deepEqual(entry.models, [{
    id: "reasoner",
    name: "Reasoner",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
  }]);
});

test("an omitted apiKeyEnv leaves Pi's own provider auth in charge", () => {
  const entry = piProviderEntry({
    id: "gateway",
    api: "openai-completions",
    baseUrl: "https://gateway.example.test/v1",
    models: [{ id: "reasoner", contextWindow: 1_000_000, maxTokens: 65_536 }],
  });
  expect(entry.apiKey).toBeUndefined();
});

test("a model without a name, modalities or reasoning declares Pi's text default at zero cost", () => {
  expect(piProviderEntry(gateway()).models).toEqual([{
    id: "reasoner",
    name: "reasoner",
    input: ["text"],
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }]);
});

test("a declaration Pi cannot honour is refused before any session starts", () => {
  const cases: readonly [string, PiSessionProvider][] = [
    ["not a provider id", gateway({ id: "ga teway" })],
    ["not an absolute URL", gateway({ baseUrl: "/v1" })],
    ["not HTTP(S)", gateway({ baseUrl: "ftp://gateway.example.test/v1" })],
    ["a query", gateway({ baseUrl: "https://gateway.example.test/v1?key=1" })],
    ["credentials", gateway({ baseUrl: "https://user:pass@gateway.example.test/v1" })],
    ["no models", gateway({ models: [] })],
    ["no gate", gateway({ apiKeyEnv: "NOT A NAME" })],
    ["a duplicate id", gateway({ models: [{ id: "m", contextWindow: 10, maxTokens: 1 }, { id: "m", contextWindow: 10, maxTokens: 1 }] })],
    ["no context window", gateway({ models: [{ id: "m", contextWindow: 0, maxTokens: 1 }] })],
    ["no completion limit", gateway({ models: [{ id: "m", contextWindow: 10, maxTokens: 0 }] })],
    ["more completion than context", gateway({ models: [{ id: "m", contextWindow: 10, maxTokens: 11 }] })],
  ];
  for (const [why, provider] of cases) {
    expect(() => { checkPiProvider(provider); }, why).toThrow(UnsupportedOptionError);
  }
});

test("a valid declaration passes the pre-flight check", () => {
  expect(() => { checkPiProvider(gateway()); }).not.toThrow();
});

test("a bare model id the provider serves is qualified with the provider's id", () => {
  const provider = gateway();
  assert.equal(piProviderModelId(provider, "reasoner"), "gateway/reasoner");
  // An id the provider does not serve, and a qualified one, are left to Pi.
  assert.equal(piProviderModelId(provider, "other-model"), "other-model");
  assert.equal(piProviderModelId(provider, "catalog/model"), "catalog/model");
});

test("a new session defaults to the provider's first model; a resumed one keeps what it recorded", () => {
  const provider = gateway();
  assert.equal(piRequestedModel(provider, undefined, false), "gateway/reasoner");
  assert.equal(piRequestedModel(provider, undefined, true), undefined);
  assert.equal(piRequestedModel(provider, "reasoner", true), "gateway/reasoner");
});

test("a compaction budget Pi cannot honour is refused", () => {
  for (const compaction of [{ reserveTokens: 0 }, { reserveTokens: -1 }, { reserveTokens: 1.5 }, { reserveTokens: 100, keepRecentTokens: 0 }]) {
    expect(() => { checkPiCompaction(compaction); }).toThrow(UnsupportedOptionError);
  }
  expect(() => { checkPiCompaction({ reserveTokens: 16_384 }); }).not.toThrow();
  expect(() => { checkPiCompaction({ reserveTokens: 16_384, keepRecentTokens: 8192 }); }).not.toThrow();
});

test("every runtime but Pi refuses a host-declared provider and compaction budget", () => {
  expect(() => { refuseSessionOptions(piOnlyRefusals, { cwd: "/tmp", piProvider: gateway() }); })
    .toThrow(/Only the Pi runtime takes a host-declared provider/u);
  expect(() => { refuseSessionOptions(piOnlyRefusals, { cwd: "/tmp", piCompaction: { reserveTokens: 100 } }); })
    .toThrow(/Only the Pi runtime takes a host-declared compaction budget/u);
  // Omitted is nothing given: no runtime refuses an absent declaration.
  expect(() => { refuseSessionOptions(piOnlyRefusals, { cwd: "/tmp" }); }).not.toThrow();
});
