import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { cursorListModelsWith, projectCursorModels } from "../../packages/oar/src/runtimes/cursor/list-models.js";
import { cursorEffortParameter, cursorModelSelection } from "../../packages/oar/src/runtimes/cursor/model.js";
import type { CursorSdk, ModelListItem, ModelSelection } from "../../packages/oar/src/runtimes/cursor/sdk.js";

// Entries of `Cursor.models.list()` as `@cursor/sdk` 1.0.35 answered on
// 2026-10-03, trimmed to the fields OAR reads.
const levels = (...values: string[]): { value: string }[] => values.map((value) => ({ value }));
const catalog: ModelListItem[] = [
  { id: "default", displayName: "Auto", aliases: ["auto"], variants: [{ params: [], displayName: "Auto", isDefault: true }] },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer"],
    parameters: [{ id: "fast", values: levels("false", "true") }],
    variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5", isDefault: true }],
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    parameters: [
      { id: "thinking", values: levels("false", "true") },
      { id: "context", values: levels("300k", "1m") },
      { id: "effort", values: levels("low", "medium", "high", "xhigh", "max") },
    ],
    variants: [{ params: [{ id: "thinking", value: "true" }, { id: "context", value: "300k" }, { id: "effort", value: "high" }], displayName: "Claude Opus 5", isDefault: true }],
  },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", parameters: [{ id: "reasoning", values: levels("none", "low", "medium", "high") }] },
  { id: "grok-4.7", displayName: "Grok 4.7", parameters: [{ id: "reasoning_effort", values: levels("low", "high") }] },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", parameters: [{ id: "thinking", values: levels("false", "true") }] },
];

test("the model list carries each model's reasoning menu and the default variant's level", () => {
  assert.deepEqual(projectCursorModels(catalog), [
    { id: "default", displayName: "Auto" },
    { id: "composer-2.5", displayName: "Composer 2.5" },
    { id: "claude-opus-5", displayName: "Claude Opus 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
    { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", effortLevels: ["none", "low", "medium", "high"] },
    { id: "grok-4.7", displayName: "Grok 4.7", effortLevels: ["low", "high"] },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", effortLevels: ["false", "true"] },
  ]);
});

test("the level menu wins over the thinking switch, which a model with nothing else keeps", () => {
  const byId = (id: string): ModelListItem => catalog.find((model) => model.id === id) ?? assert.fail(id);
  assert.equal(cursorEffortParameter(byId("claude-opus-5"))?.id, "effort");
  assert.equal(cursorEffortParameter(byId("claude-haiku-4-5"))?.id, "thinking");
  assert.equal(cursorEffortParameter(byId("composer-2.5")), null);
});

function sdkWith(runs: readonly { model?: ModelSelection; createdAt?: number }[][] = []): CursorSdk & { readonly listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    Agent: {
      create: () => assert.fail("not used"),
      resume: () => assert.fail("not used"),
      listRuns: async (agentId, options) => {
        listed.push(`${agentId}@${options.cursor ?? "start"}`);
        const page = Number(options.cursor ?? "0");
        await Promise.resolve();
        return { items: runs[page] ?? [], ...(page + 1 < runs.length ? { nextCursor: String(page + 1) } : {}) };
      },
    },
    Cursor: {
      models: {
        list: async () => {
          await Promise.resolve();
          return catalog;
        },
      },
    },
  };
}

test("a model without effort opens as asked; no model opens Cursor's Auto", async () => {
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "composer" }), { id: "composer" });
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w" }), { id: "default" });
});

test("an effort is set through the model's own parameter, after checking its menu", async () => {
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "gpt-5.4-mini", effort: "low" }), {
    id: "gpt-5.4-mini",
    params: [{ id: "reasoning", value: "low" }],
  });
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "gpt-5.4-mini", effort: "ludicrous" })).rejects.toThrow(
    "Cursor model gpt-5.4-mini does not offer effort ludicrous; it lists none, low, medium, high",
  );
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "composer-2.5", effort: "high" })).rejects.toThrow(
    "Cursor model composer-2.5 has no effort setting; requested effort high",
  );
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "no-such", effort: "high" })).rejects.toThrow(
    "Cursor does not list model no-such",
  );
});

test("a resume without a model reopens what the agent's latest run ran, across pages", async () => {
  const sdk = sdkWith([
    [{ model: { id: "composer-2.5" }, createdAt: 1 }, { createdAt: 5 }],
    [{ model: { id: "claude-opus-5", params: [{ id: "context", value: "1m" }, { id: "effort", value: "max" }] }, createdAt: 3 }],
  ]);
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w", resume: "agent-1" }), {
    id: "claude-opus-5",
    params: [{ id: "context", value: "1m" }, { id: "effort", value: "max" }],
  });
  assert.deepEqual(sdk.listed, ["agent-1@start", "agent-1@1"]);
  // A new effort replaces the recorded one and keeps the other parameters.
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w", resume: "agent-1", effort: "low" }), {
    id: "claude-opus-5",
    params: [{ id: "context", value: "1m" }, { id: "effort", value: "low" }],
  });
  assert.deepEqual(await cursorModelSelection(sdkWith([[]]), { cwd: "/w", resume: "agent-2" }), { id: "default" });
});

test("listing models without a credential is unauthenticated, not an empty list", async () => {
  const refused = sdkWith();
  const sdk: CursorSdk = {
    ...refused,
    Cursor: {
      models: {
        list: async () => {
          await Promise.resolve();
          throw new Error("API key is required for cloud operations. Set CURSOR_API_KEY, pass apiKey, or run Cursor.auth.login().");
        },
      },
    },
  };
  const list = cursorListModelsWith(async () => {
    await Promise.resolve();
    return sdk;
  });
  assert.deepEqual(await list({ kind: "available", via: "bundled" }), {
    kind: "unauthenticated",
    detail: "API key is required for cloud operations. Set CURSOR_API_KEY, pass apiKey, or run Cursor.auth.login().",
  });
  const ok = cursorListModelsWith(async () => {
    await Promise.resolve();
    return sdkWith();
  });
  const listed = await ok({ kind: "available", via: "bundled" });
  assert.equal(listed.kind, "ok");
  assert.deepEqual(await ok({ kind: "available", via: "executable", command: "cursor-agent" }), {
    kind: "unsupported",
    reason: "cursor model listing needs the bundled @cursor/sdk",
  });
});
