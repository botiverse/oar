import { expect, test } from "vitest";
import { effortLevelOf, effortLevelsOf } from "../packages/oar/src/shared/effort-levels.js";
import { claudeListModels, projectClaudeModels } from "../packages/oar/src/runtimes/claude/list-models.js";
import { codexListModels, projectCodexModels } from "../packages/oar/src/runtimes/codex/list-models.js";
import { grokListModels, grokModelState, projectGrokModels } from "../packages/oar/src/runtimes/grok/list-models.js";
import { kimiListModels } from "../packages/oar/src/runtimes/kimi/list-models.js";
import { piListModels, projectPiModels } from "../packages/oar/src/runtimes/pi/list-models.js";
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

test("pi projection namespaces ids by provider", () => {
  expect(projectPiModels([
    { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5" },
    { id: "gpt-5.5", provider: "openai", name: " " },
  ])).toEqual([
    { id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
    { id: "openai/gpt-5.5", displayName: "gpt-5.5" },
  ]);
});

test("kimi reports unsupported with a reason", async () => {
  await expect(kimiListModels(executable)).resolves.toEqual({
    kind: "unsupported",
    reason: "kimi exposes no model listing surface (no CLI subcommand or wire method)",
  });
});

test("executable listers refuse bundled installations and pi refuses executables", async () => {
  const results = await Promise.all([
    codexListModels(bundled),
    claudeListModels(bundled),
    grokListModels(bundled),
    piListModels(executable),
  ]);
  for (const result of results) {
    expect(result).toMatchObject({ kind: "unsupported" });
  }
});
