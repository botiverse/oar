import { expect, test } from "vitest";
import { effortLevelOf, effortLevelsOf } from "../packages/oar/src/shared/effort-levels.js";
import { claudeListModels, projectClaudeModels } from "../packages/oar/src/runtimes/claude/list-models.js";
import { codexListModels, projectCodexModels } from "../packages/oar/src/runtimes/codex/list-models.js";
import { cursorListModels, projectCursorModels } from "../packages/oar/src/runtimes/cursor/list-models.js";
import { grokListModels, grokModelState, projectGrokModels } from "../packages/oar/src/runtimes/grok/list-models.js";
import { kimiListModels } from "../packages/oar/src/runtimes/kimi/list-models.js";
import { createPiListModels, piListModels, projectPiModels } from "../packages/oar/src/runtimes/pi/list-models.js";
import { runtimes } from "../packages/oar/src/index.js";

const executable = { kind: "available", via: "executable", command: "x", version: "1" } as const;
const bundled = { kind: "available", via: "bundled", version: "1" } as const;

test("every registered runtime exposes listModels", () => {
  for (const runtime of runtimes.list()) {
    expect(typeof runtime.listModels, runtime.id).toBe("function");
  }
});

test("effortLevelsOf accepts strings and {effort}/{id} objects", () => {
  expect(effortLevelsOf(undefined)).toBeUndefined();
  expect(effortLevelsOf("high")).toBeUndefined();
  expect(effortLevelsOf([])).toEqual([]);
  expect(effortLevelsOf(["low", { effort: "high", description: "x" }, { id: "max" }, {}, 3])).toEqual([
    "low",
    "high",
    "max",
  ]);
  expect(effortLevelOf("medium")).toBe("medium");
  expect(effortLevelOf({ effort: "xhigh" })).toBe("xhigh");
  expect(effortLevelOf("")).toBeUndefined();
});

test("codex projection keeps slug identity, drops hidden entries, flattens effort objects", () => {
  const models = projectCodexModels({
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT 5.5 ",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "" },
          { effort: "high", description: "" },
        ],
        visibility: "list",
      },
      { slug: "hidden-one", visibility: "hide", supported_reasoning_levels: [] },
      { display_name: "no slug", visibility: "list" },
      { slug: "bare", visibility: "list" },
    ],
  });
  expect(models).toEqual([
    { id: "gpt-5.5", displayName: "GPT 5.5", effortLevels: ["low", "high"], defaultEffort: "medium" },
    { id: "bare" },
  ]);
  expect(projectCodexModels(null)).toEqual([]);
});

test("claude projection keeps alias vs resolution and disabled reasons", () => {
  const models = projectClaudeModels({
    models: [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", supportedEffortLevels: null },
      {
        value: "cc-update-required-1",
        displayName: "Fable 5.1",
        description: "Update to 2.1.255+ to use Fable 5.1",
        disabled: true,
      },
      { value: "", displayName: "dropped" },
    ],
  });
  expect(models).toEqual([
    { id: "sonnet", resolvedId: "claude-sonnet-5", displayName: "Sonnet", effortLevels: ["low", "high"] },
    { id: "haiku", resolvedId: "claude-haiku-4-5-20251001" },
    {
      id: "cc-update-required-1",
      displayName: "Fable 5.1",
      disabled: { reason: "Update to 2.1.255+ to use Fable 5.1" },
    },
  ]);
});

test("grok projection unwraps the handler envelope and filters unselectable models", () => {
  const state = grokModelState({
    result: {
      currentModelId: "grok-4",
      availableModels: [
        {
          modelId: "grok-4",
          name: "Grok 4",
          reasoning_efforts: ["low", { effort: "high" }],
          default_reasoning_effort: "low",
        },
        { model_id: "grok-hidden", hidden: true },
        { modelId: "grok-internal", user_selectable: false },
        { modelId: "grok-3-mini", displayName: "Grok 3 mini" },
      ],
    },
  });
  expect(projectGrokModels(state)).toEqual([
    { id: "grok-4", displayName: "Grok 4", effortLevels: ["low", "high"], defaultEffort: "low" },
    { id: "grok-3-mini", displayName: "Grok 3 mini" },
  ]);
  expect(projectGrokModels(grokModelState({ available_models: [{ id: "flat" }] }))).toEqual([{ id: "flat" }]);
  expect(() => grokModelState({ error: { message: "boom" } })).toThrow(/boom/u);
});

test("cursor projection reads each model's thought_level parameter as its effort menu", () => {
  const thoughtLevel = {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
  };
  expect(projectCursorModels({
    models: [
      { value: "gpt-6", name: "GPT 6", configOptions: [thoughtLevel, { id: "fast", category: "model_config", currentValue: "false" }] },
      { value: "composer-2", name: "composer-2", configOptions: [] },
      { name: "no value" },
    ],
  })).toEqual([
    { id: "gpt-6", displayName: "GPT 6", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "composer-2" },
  ]);
  expect(projectCursorModels({})).toEqual([]);
});

// pi's own menu per model (pi-ai getSupportedThinkingLevels), injected; a
// model without `reasoning` runs only `off` and lists none.
function piLevels(model: { readonly id: string }): readonly string[] {
  return model.id === "gpt-6-astra" ? ["minimal", "low", "medium", "high", "xhigh", "max"] : ["off", "minimal", "low", "medium", "high"];
}

test("pi projection lists pi's thinking levels for reasoning models only", () => {
  expect(projectPiModels([
    { id: "gpt-6-astra", provider: "openai-codex", name: "GPT-6 Astra", reasoning: true },
    { id: "deepseek-v3.2", provider: "openrouter", name: "DeepSeek V3.2", reasoning: true },
    { id: "deepseek-chat", provider: "openrouter", name: "DeepSeek Chat", reasoning: false },
  ], piLevels)).toEqual([
    { id: "openai-codex/gpt-6-astra", displayName: "GPT-6 Astra", effortLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    { id: "openrouter/deepseek-v3.2", displayName: "DeepSeek V3.2", effortLevels: ["off", "minimal", "low", "medium", "high"] },
    { id: "openrouter/deepseek-chat", displayName: "DeepSeek Chat" },
  ]);
});

test("pi projection namespaces ids by provider", () => {
  expect(projectPiModels([
    { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5" },
    { id: "gpt-5.5", provider: "openai", name: " " },
  ])).toEqual([
    { id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
    { id: "openai/gpt-5.5", displayName: "gpt-5.5" },
  ]);
});

test("pi lister awaits getAvailable instead of reading the unrefreshed snapshot", async () => {
  // Regression for `oar models pi` printing "no models" while `pi --list-models`
  // showed twenty: ModelRegistry.getAvailable() only echoes a snapshot that is
  // empty until an availability refresh runs. The lister must ask the runtime
  // to compute availability and must hand the same timeout signal to both
  // the runtime construction (extension loading) and the availability call.
  const seen: { providerId: string | undefined; signal: AbortSignal | undefined }[] = [];
  let constructionSignal: AbortSignal | undefined = undefined;
  const lister = createPiListModels(async (signal) => {
    constructionSignal = signal;
    return {
      async getAvailable(providerId?: string, options?: { readonly signal?: AbortSignal }) {
        seen.push({ providerId, signal: options?.signal });
        return [{ id: "grok-4.6", provider: "xai", name: "Grok 4.6" }];
      },
    };
  });
  expect(await lister(bundled, { timeoutMs: 1000 })).toEqual({
    kind: "ok",
    models: [{ id: "xai/grok-4.6", displayName: "Grok 4.6" }],
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.providerId).toBeUndefined();
  expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(constructionSignal).toBe(seen[0]?.signal);

  const failing = createPiListModels(async () => ({
    async getAvailable() {
      await Promise.resolve();
      throw new Error("registry exploded");
    },
  }));
  expect(await failing(bundled)).toMatchObject({ kind: "unsupported", reason: /registry exploded/u });
});

test("pi lister reports a configured provider through the real SDK", async () => {
  // End-to-end through the bundled SDK with a dummy key: any API-key provider
  // counts as available without network, so this pins that the in-process
  // path actually populates the list (it was empty before the fix). The
  // extension-registered providers are environment-specific, so parity with
  // `pi --list-models` is pinned by experiments/pi-list-models.ts instead.
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "dummy-not-a-real-key";
  try {
    const result = await piListModels(bundled, { timeoutMs: 15_000 });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.models.some((model) => model.id.startsWith("xai/"))).toBe(true);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = previous;
    }
  }
});

test("executable listers refuse bundled installations and pi refuses executables", async () => {
  const results = await Promise.all([
    codexListModels(bundled),
    claudeListModels(bundled),
    cursorListModels(bundled),
    grokListModels(bundled),
    kimiListModels(bundled),
    piListModels(executable),
  ]);
  for (const result of results) {
    expect(result).toMatchObject({ kind: "unsupported" });
  }
});
