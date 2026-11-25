/*
 * SessionOptions.dshProvider: the typed declaration, the private `--patch` rows
 * it becomes, and the fail-closed confirmation the real bridge text runs over a
 * stand-in executable. What real DSH does with the rows is pinned in
 * sea-trial/vendor/dsh-host-provider.vendor.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, test } from "vitest";
import type { DshSessionProvider } from "../../packages/oar/src/contracts/dsh-provider.js";
import { dshRuntime, UnsupportedOptionError, type Session } from "../../packages/oar/src/index.js";
import { dshAgentOptions } from "../../packages/oar/src/runtimes/dsh/options.js";
import { checkDshProvider, dshProviderAudit, dshProviderPatchRow, dshProviderRequestedModel } from "../../packages/oar/src/runtimes/dsh/provider.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-provider-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
const installation = { kind: "available", via: "executable", command, version: "0.2.1-rc.5" } as const;
afterAll(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

const baseUrl = "http://127.0.0.1:9/v1";

const provider: DshSessionProvider = {
  id: "gateway",
  api: "openai-completions",
  baseUrl,
  apiKeyEnv: "GATEWAY_API_KEY",
  models: [
    { id: "reasoner", contextWindow: 200_000, maxTokens: 8192, reasoningEfforts: { low: "low", high: "high" } },
  ],
};

const SECRET = "sk-oar-provider-secret-value";

interface OpenCase {
  readonly env?: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly dshProvider?: DshSessionProvider;
}

async function open(options: OpenCase = {}): Promise<Session> {
  return dshRuntime.session(installation, { cwd: dir, ...options, dshProvider: options.dshProvider ?? provider });
}

async function refusal(options: OpenCase = {}): Promise<unknown> {
  try { return await open(options); } catch (error) { return error; }
}

/** The cases below are declarations no type would accept; checkDshProvider is the boundary that parses them. */
const checking = (declaration: unknown): (() => void) => (): void => {
  // oxlint-disable-next-line no-unsafe-type-assertion, consistent-type-assertions -- those cases exist to be refused.
  checkDshProvider(declaration as DshSessionProvider);
};

describe("the declaration DSH receives", () => {
  test("becomes one llm-pi-ai row carrying the endpoint, the wire and the credential's NAME", () => {
    expect(dshProviderPatchRow(provider)).toEqual({
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: {
        providers: {
          gateway: {
            apiKeyEnv: "GATEWAY_API_KEY",
            api: "openai-completions",
            baseURL: baseUrl,
            models: [{ id: "reasoner", contextWindow: 200_000, maxTokens: 8192, reasoningEfforts: { low: "low", high: "high" } }],
          },
        },
      },
    });
  });

  test("writes only what the host declared: no invented limits, modalities, levels or compatibility", () => {
    const bare: DshSessionProvider = { id: "bare", api: "anthropic-messages", baseUrl: "https://gateway.example.test/", models: [{ id: "m", contextWindow: 1000 }] };
    expect(dshProviderPatchRow(bare)).toEqual({
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: { providers: { bare: { api: "anthropic-messages", baseURL: "https://gateway.example.test", models: [{ id: "m", contextWindow: 1000 }] } } },
    });
  });

  test("the bridge audit names ids only, never a credential value", () => {
    expect(dshProviderAudit(provider)).toEqual({
      pluginId: "llm-pi-ai",
      pluginName: "@deepseek-ai/dsh-llm-pi-ai",
      id: "gateway",
      api: "openai-completions",
      baseURL: baseUrl,
      apiKeyEnv: "GATEWAY_API_KEY",
      models: ["reasoner"],
    });
  });
});

describe("reasoning levels and wire compatibility pass through verbatim", () => {
  test("models keep the three-state levels and the compat block exactly as declared", () => {
    const mixed: DshSessionProvider = {
      id: "gw", api: "openai-completions", baseUrl, models: [
        { id: "off", contextWindow: 1000, reasoningEfforts: false },
        { id: "levels", contextWindow: 1000, reasoningEfforts: { high: "HIGH", max: "max" }, compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" } },
        { id: "inherit", contextWindow: 1000 },
      ],
    };
    expect(dshProviderPatchRow(mixed)).toEqual({
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: {
        providers: {
          gw: {
            api: "openai-completions",
            baseURL: baseUrl,
            models: [
              { id: "off", contextWindow: 1000, reasoningEfforts: false },
              { id: "levels", contextWindow: 1000, reasoningEfforts: { high: "HIGH", max: "max" }, compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" } },
              { id: "inherit", contextWindow: 1000 },
            ],
          },
        },
      },
    });
  });
});

describe("the model a declared provider runs", () => {
  test("a bare id the provider serves is qualified with its id", () => {
    expect(dshProviderRequestedModel(provider, "reasoner", false)).toBe("gateway/reasoner");
    expect(dshAgentOptions({ model: "reasoner", dshProvider: provider })).toEqual({ provider: "gateway", model: "reasoner" });
  });

  test("a qualified id must name this provider and one of its models", () => {
    expect(dshProviderRequestedModel(provider, "gateway/reasoner", false)).toBe("gateway/reasoner");
    expect(() => dshProviderRequestedModel(provider, "deepseek-official/deepseek-flash", false)).toThrow(/declares provider "gateway"/u);
    expect(() => dshProviderRequestedModel(provider, "reasoner-plus", false)).toThrow(/serves \["reasoner"\]/u);
  });

  test("no model runs the first declared one on a new session and keeps the saved route on resume", () => {
    expect(dshProviderRequestedModel(provider, undefined, false)).toBe("gateway/reasoner");
    expect(dshProviderRequestedModel(provider, undefined, true)).toBeUndefined();
    expect(dshAgentOptions({ dshProvider: provider })).toEqual({ provider: "gateway", model: "reasoner" });
    expect(dshAgentOptions({ dshProvider: provider, resume: "saved" })).toEqual({});
  });

  test("a model id containing a slash must be given qualified", () => {
    const slashed: DshSessionProvider = { id: "local", api: "openai-completions", baseUrl, models: [{ id: "meta-llama/Llama-3", contextWindow: 1000 }] };
    expect(dshProviderRequestedModel(slashed, "local/meta-llama/Llama-3", false)).toBe("local/meta-llama/Llama-3");
    expect(() => dshProviderRequestedModel(slashed, "meta-llama/Llama-3", false)).toThrow(/declares provider "local"/u);
  });
});

describe("a declaration OAR cannot honour is refused before anything starts", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["an empty provider id", { ...provider, id: "" }],
    ["an id starting with a dash", { ...provider, id: "-gateway" }],
    ["an id containing a slash", { ...provider, id: "gateway/v2" }],
    ["a reserved object-member id", { ...provider, id: "__proto__" }],
    ["an unmodelled wire", { ...provider, api: "google-generative-ai" }],
    ["a relative endpoint", { ...provider, baseUrl: "/v1" }],
    ["a non-HTTP endpoint", { ...provider, baseUrl: "ftp://gateway.example.test/v1" }],
    ["an endpoint carrying a query", { ...provider, baseUrl: `${baseUrl}?key=1` }],
    ["an endpoint carrying a fragment", { ...provider, baseUrl: `${baseUrl}#x` }],
    ["an endpoint carrying credentials", { ...provider, baseUrl: "http://user:pass@127.0.0.1:9/v1" }],
    ["a credential value instead of a variable NAME", { ...provider, apiKeyEnv: "sk-live-123" }],
    ["no models", { ...provider, models: [] }],
    ["a blank model id", { ...provider, models: [{ id: "  ", contextWindow: 1000 }] }],
    ["a model id with a control character", { ...provider, models: [{ id: "a\u0000b", contextWindow: 1000 }] }],
    ["the same model twice", { ...provider, models: [{ id: "m", contextWindow: 1000 }, { id: "m", contextWindow: 1000 }] }],
    ["no context window", { ...provider, models: [{ id: "m", contextWindow: 0 }] }],
    ["a completion limit above the context window", { ...provider, models: [{ id: "m", contextWindow: 1000, maxTokens: 2000 }] }],
    ["an unknown input modality", { ...provider, models: [{ id: "m", contextWindow: 1000, input: ["audio"] }] }],
    ["an unknown reasoning level", { ...provider, models: [{ id: "m", contextWindow: 1000, reasoningEfforts: { turbo: "turbo" } }] }],
    ["an empty reasoning level map", { ...provider, models: [{ id: "m", contextWindow: 1000, reasoningEfforts: {} }] }],
    ["a level with no wire spelling", { ...provider, models: [{ id: "m", contextWindow: 1000, reasoningEfforts: { high: "  " } }] }],
    ["a non-boolean compatibility switch", { ...provider, models: [{ id: "m", contextWindow: 1000, compat: { supportsStore: "no" } }] }],
    ["an unknown token-limit field", { ...provider, models: [{ id: "m", contextWindow: 1000, compat: { maxTokensField: "max_output_tokens" } }] }],
    ["an unknown thinking format", { ...provider, models: [{ id: "m", contextWindow: 1000, compat: { thinkingFormat: "vendor" } }] }],
  ];

  test.each(cases)("%s", (_name, declaration) => {
    expect(checking(declaration)).toThrow(UnsupportedOptionError);
    expect(checking(declaration)).toThrow(/dshProvider/u);
  });

  test("a host that names another provider's model is refused without spawning anything", async () => {
    const receipt = path.join(dir, "never-written.json");
    const failed = await refusal({ env: { FAKE_DSH_PATCH_RECEIPT: receipt }, model: "deepseek-official/deepseek-flash" });
    expect(failed).toMatchObject({ name: "UnsupportedOptionError", option: "dshProvider" });
    expect(existsSync(receipt)).toBe(false);
  });
});

describe("DSH with a host-declared provider", () => {
  test("opens, and its own private patch carries the declaration without the key's value", async () => {
    const receipt = path.join(dir, "patch-receipt.json");
    const session = await open({ env: { FAKE_DSH_PATCH_RECEIPT: receipt, GATEWAY_API_KEY: SECRET }, model: "reasoner" });
    await session.dispose();
    const written = readFileSync(receipt, "utf8");
    expect(JSON.parse(written)).toContainEqual(dshProviderPatchRow(provider));
    expect(written).toContain("GATEWAY_API_KEY");
    expect(written).not.toContain(SECRET);
  });

  test("the declaration is never recorded, and the key's value never reaches a record", async () => {
    const session = await open({ env: { GATEWAY_API_KEY: SECRET }, model: "reasoner" });
    try {
      await session.prompt("hello");
      await delay(60);
      const recorded = JSON.stringify(session.records());
      expect(recorded).not.toContain(SECRET);
      expect(recorded).not.toContain(baseUrl);
    } finally { await session.dispose(); }
  });

  test("a declared provider DSH did not mount fails the open closed", async () => {
    const cases: readonly Readonly<Record<string, string>>[] = [
      { FAKE_DSH_PROVIDER_MISSING: "1" },
      { FAKE_DSH_PROVIDER_IGNORE_PATCH: "1" },
      { FAKE_DSH_PROVIDER_DISABLED: "1" },
      { FAKE_DSH_PROVIDER_NAME: "@deepseek-ai/other-plugin" },
      { FAKE_DSH_PROVIDER_STATE: "0" },
    ];
    for (const env of cases) {
      // oxlint-disable-next-line no-await-in-loop -- sequential opens keep each startup refusal isolated.
      const failed = await refusal({ env });
      expect(failed, JSON.stringify(env)).toMatchObject({ name: "UnsupportedOptionError", option: "dshProvider" });
    }
  });

  test("the declaration is not kept when the option is omitted", async () => {
    const receipt = path.join(dir, "plain-patch.json");
    const session = await dshRuntime.session(installation, { cwd: dir, env: { FAKE_DSH_PATCH_RECEIPT: receipt } });
    await session.dispose();
    expect(readFileSync(receipt, "utf8")).not.toContain("llm-pi-ai");
  });
});
