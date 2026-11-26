import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { createCursorRuntime } from "../../packages/oar/src/runtimes/cursor/index.js";
import { cursorListModelsWith, projectCursorModels } from "../../packages/oar/src/runtimes/cursor/list-models.js";
import { cursorEffortParameter, cursorFastParameter, cursorModelSelection } from "../../packages/oar/src/runtimes/cursor/model.js";
import type { CursorSdk, ModelListItem, ModelSelection } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { FakeCursorAgent } from "../fixtures/fake-cursor-sdk.js";

// Entries of `Cursor.models.list()` as `@cursor/sdk` 1.0.35 / 1.4.1 answered,
// trimmed to the fields OAR reads.
const levels = (...values: string[]): { value: string }[] => values.map((value) => ({ value }));
const catalog: ModelListItem[] = [
  { id: "default", displayName: "Auto", aliases: ["auto"], variants: [{ params: [], displayName: "Auto", isDefault: true }] },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer"],
    parameters: [{ id: "fast", values: levels("false", "true") }],
    variants: [
      { params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5", isDefault: true },
      { params: [{ id: "fast", value: "false" }], displayName: "Composer 2.5" },
    ],
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    parameters: [
      { id: "thinking", values: levels("false", "true") },
      { id: "context", values: levels("300k", "1m") },
      { id: "effort", values: levels("low", "medium", "high", "xhigh", "max") },
      { id: "fast", values: levels("false", "true") },
    ],
    variants: [{ params: [{ id: "thinking", value: "true" }, { id: "context", value: "300k" }, { id: "effort", value: "high" }, { id: "fast", value: "false" }], displayName: "Claude Opus 5", isDefault: true }],
  },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", parameters: [{ id: "reasoning", values: levels("none", "low", "medium", "high") }] },
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      { id: "context", values: levels("256k", "500k") },
      { id: "reasoning_effort", values: levels("low", "high") },
      { id: "fast", values: levels("false", "true") },
    ],
    variants: [{ params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }], displayName: "Grok 4.7 High Fast", isDefault: true }],
  },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", parameters: [{ id: "thinking", values: levels("false", "true") }], variants: [{ params: [{ id: "thinking", value: "true" }], displayName: "Claude Haiku 4.5", isDefault: true }] },
  { id: "fast-only", displayName: "Fast Only", parameters: [{ id: "fast", values: levels("true") }], variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Fast Only", isDefault: true }] },
];

test("the model list carries each model's reasoning menu, service tiers, and default variant choices", () => {
  assert.deepEqual(projectCursorModels(catalog), [
    { id: "default", displayName: "Auto" },
    { id: "composer-2.5", displayName: "Composer 2.5", serviceTiers: ["fast"], defaultServiceTier: "fast" },
    { id: "claude-opus-5", displayName: "Claude Opus 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", serviceTiers: ["fast"] },
    { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", effortLevels: ["none", "low", "medium", "high"] },
    { id: "grok-4.7", displayName: "Grok 4.7", effortLevels: ["low", "high"], defaultEffort: "high", serviceTiers: ["fast"], defaultServiceTier: "fast" },
    { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", effortLevels: ["false", "true"], defaultEffort: "true" },
    { id: "fast-only", displayName: "Fast Only", serviceTiers: ["fast"], defaultServiceTier: "fast" },
  ]);
});

test("the level menu wins over the thinking switch, which a model with nothing else keeps", () => {
  const byId = (id: string): ModelListItem => catalog.find((model) => model.id === id) ?? assert.fail(id);
  assert.equal(cursorEffortParameter(byId("claude-opus-5"))?.id, "effort");
  assert.equal(cursorEffortParameter(byId("claude-haiku-4-5"))?.id, "thinking");
  assert.equal(cursorEffortParameter(byId("composer-2.5")), null);
  assert.deepEqual(cursorFastParameter(byId("composer-2.5")), { values: ["false", "true"] });
  assert.equal(cursorFastParameter(byId("gpt-5.4-mini")), null);
});

function sdkWith(runs: readonly { model?: ModelSelection; createdAt?: number }[][] = []): CursorSdk & { readonly listed: string[]; modelListCalls: number } {
  const listed: string[] = [];
  const sdk: CursorSdk & { readonly listed: string[]; modelListCalls: number } = {
    listed,
    modelListCalls: 0,
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
          sdk.modelListCalls += 1;
          await Promise.resolve();
          return catalog;
        },
      },
    },
  };
  return sdk;
}

test("a model without effort or serviceTier opens as asked with zero models.list() calls; no model opens Cursor's Auto", async () => {
  const sdk = sdkWith();
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w", model: "composer" }), { id: "composer" });
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w" }), { id: "default" });
  assert.equal(sdk.modelListCalls, 0);
});

test("an effort is set through the model's own parameter, after checking its menu", async () => {
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "gpt-5.4-mini", effort: "low" }), {
    id: "gpt-5.4-mini",
    params: [{ id: "reasoning", value: "low" }],
  });
  // The other parameters stay as the default variant sets them: thinking, context and fast stay beside the level.
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "claude-opus-5", effort: "low" }), {
    id: "claude-opus-5",
    params: [{ id: "thinking", value: "true" }, { id: "context", value: "300k" }, { id: "fast", value: "false" }, { id: "effort", value: "low" }],
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

test("serviceTier sets explicit params.fast after checking the catalog, preserves other params, and shares one models.list() call with effort", async () => {
  // Explicit opt-out on a fast-by-default model (including alias resolution).
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "composer", serviceTier: "default" }), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "false" }],
  });
  // Explicit fast on a fast-capable model.
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "composer-2.5", serviceTier: "fast" }), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  });
  // Multi-parameter model: serviceTier alone keeps default context & reasoning_effort.
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "grok-4.7", serviceTier: "default" }), {
    id: "grok-4.7",
    params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "false" }],
  });
  // Effort + serviceTier together share a single models.list() fetch and replace both params.
  const shared = sdkWith();
  assert.deepEqual(await cursorModelSelection(shared, { cwd: "/w", model: "grok-4.7", effort: "low", serviceTier: "default" }), {
    id: "grok-4.7",
    params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "low" }, { id: "fast", value: "false" }],
  });
  assert.equal(shared.modelListCalls, 1);
});

test("serviceTier rejects unsupported models, fast-only default opt-out, unknown tiers, and avoids expanding defaults on no-op default", async () => {
  // Models without a fast parameter accept serviceTier: "default" cleanly without materializing unrelated default-variant params, and reject "fast".
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "gpt-5.4-mini", serviceTier: "default" }), {
    id: "gpt-5.4-mini",
  });
  assert.deepEqual(await cursorModelSelection(sdkWith(), { cwd: "/w", model: "claude-haiku-4-5", serviceTier: "default" }), {
    id: "claude-haiku-4-5",
  });
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "gpt-5.4-mini", serviceTier: "fast" })).rejects.toThrow(
    "Cursor model gpt-5.4-mini does not offer serviceTier fast",
  );
  // A fast-only model rejects serviceTier: "default" instead of silently running fast.
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "fast-only", serviceTier: "default" })).rejects.toThrow(
    "Cursor model fast-only does not offer serviceTier default",
  );
  // Unknown tier values and unlisted models reject before open.
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "composer-2.5", serviceTier: "priority" })).rejects.toThrow(
    "cursor cannot apply serviceTier priority; its tiers are default and fast (on supported models)",
  );
  await expect(cursorModelSelection(sdkWith(), { cwd: "/w", model: "no-such", serviceTier: "default" })).rejects.toThrow(
    "Cursor does not list model no-such, so serviceTier default cannot be checked",
  );
});

test("a resume without a model reopens what the agent's latest run ran, and serviceTier replaces only fast", async () => {
  const sdk = sdkWith([
    [{ model: { id: "composer-2.5" }, createdAt: 1 }, { createdAt: 5 }],
    [{ model: { id: "claude-opus-5", params: [{ id: "context", value: "1m" }, { id: "effort", value: "max" }, { id: "fast", value: "false" }] }, createdAt: 3 }],
  ]);
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w", resume: "agent-1" }), {
    id: "claude-opus-5",
    params: [{ id: "context", value: "1m" }, { id: "effort", value: "max" }, { id: "fast", value: "false" }],
  });
  assert.deepEqual(sdk.listed, ["agent-1@start", "agent-1@1"]);
  // A new effort replaces the recorded one and keeps the other parameters.
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w", resume: "agent-1", effort: "low" }), {
    id: "claude-opus-5",
    params: [{ id: "context", value: "1m" }, { id: "fast", value: "false" }, { id: "effort", value: "low" }],
  });
  // A new serviceTier replaces only fast and keeps context and effort.
  assert.deepEqual(await cursorModelSelection(sdk, { cwd: "/w", resume: "agent-1", serviceTier: "fast" }), {
    id: "claude-opus-5",
    params: [{ id: "context", value: "1m" }, { id: "effort", value: "max" }, { id: "fast", value: "true" }],
  });
  assert.deepEqual(await cursorModelSelection(sdkWith([[]]), { cwd: "/w", resume: "agent-2" }), { id: "default" });
});

function sessionTestRuntime(created: ModelSelection[]): ReturnType<typeof createCursorRuntime> {
  const sdk: CursorSdk = {
    Agent: {
      create: async (options) => {
        created.push(options.model);
        await Promise.resolve();
        return new FakeCursorAgent("agent-1", options.model);
      },
      resume: () => assert.fail("not used"),
      listRuns: async () => { await Promise.resolve(); return { items: [] }; },
    },
    Cursor: { models: { list: async () => { await Promise.resolve(); return catalog; } } },
  };
  return createCursorRuntime({ sdk: async () => { await Promise.resolve(); return sdk; } });
}

test("cursor session keeps Session.serviceTier() null (no fabricated readback) and refuses serviceTierFallback before open", async () => {
  const created: ModelSelection[] = [];
  const runtime = sessionTestRuntime(created);
  await expect(runtime.session({ kind: "available", via: "bundled" }, { cwd: "/w", model: "composer-2.5", serviceTier: "fast", serviceTierFallback: "default" }))
    .rejects.toBeInstanceOf(UnsupportedOptionError);
  assert.equal(created.length, 0);
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/w", model: "composer-2.5", serviceTier: "default" });
  try {
    assert.deepEqual(created, [{ id: "composer-2.5", params: [{ id: "fast", value: "false" }] }]);
    assert.equal(session.serviceTier().value, null);
    assert.equal(session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "service_tier")), false);
  } finally {
    await session.dispose();
  }
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
