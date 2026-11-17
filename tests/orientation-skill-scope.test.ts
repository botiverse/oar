import { expect, test } from "vitest";
import { defineRuntime, RuntimeRegistry, orient, type InventoryResult, type Runtime, type SkillEntry } from "../packages/oar/src/index.js";

function catalog(items: readonly SkillEntry[]): Extract<InventoryResult<SkillEntry>, { kind: "ok" }> {
  return { kind: "ok", items, partial: false, view: "discovered", observedAt: "2026-11-17T00:00:00.000Z", scope: { kind: "workspace", cwd: "/fixture" } };
}
async function customization(items: readonly SkillEntry[], overrides: Partial<Runtime> = {}) {
  const runtime = defineRuntime({ id: "fixture", installation: async () => ({ kind: "available", via: "bundled" }),
    session: async () => { throw new Error("must not open a session"); }, skills: async () => catalog(items), ...overrides });
  const report = await orient(new RuntimeRegistry([runtime]), { include: ["customization"] });
  return report.runtimes[0]?.customization;
}

test.each([
  ["Qwen", [{ name: "built", source: "bundled", scope: "builtin" }, { name: "mine", source: "user", scope: "user" }, { name: "extension", source: "extension", scope: "other" }], 1],
  ["DSH", [{ name: "mine", source: "user-dsh", scope: "user" }, { name: "compat", source: "user-agents", scope: "user" }, { name: "project", source: "project-dsh", scope: "project" }], 2],
  ["Devin", [{ name: "built", source: "Builtin", scope: "builtin" }], 0],
  ["Factory", [{ name: "mine", source: "personal", scope: "user", enabled: false }, { name: "plugin", source: "personal", scope: "user", plugin: "example@marketplace" }, { name: "auto", source: "automation", scope: "other" }], 2],
  ["Antigravity", [{ name: "built", scope: "builtin" }], 0],
  ["Cursor", [{ name: "mine", source: "user", scope: "user" }, { name: "project", source: "workspace", scope: "project" }], 1],
] satisfies readonly [string, readonly SkillEntry[], number][])("counts %s skills by shared scope while preserving native labels", async (_runtime, items, count) => {
  const before = structuredClone(items);
  expect(await customization(items)).toMatchObject({ kind: "ok", value: { skills: count } });
  expect(items).toEqual(before);
});

test.each([
  [{ name: "unknown", source: "user" }],
  [{ name: "builtin", source: "Builtin", scope: "builtin" }, { name: "native", source: "Devin" }],
  [{ name: "builtin", scope: "builtin" }, { name: "plugin", plugin: "native-plugin" }],
] satisfies readonly (readonly SkillEntry[])[])("omits the skill count when any scope is unknown: %j", async (...items) => {
  expect(await customization(items)).toEqual({ kind: "unsupported" });
});

test("known non-user scopes and an empty catalog produce zero", async () => {
  expect(await customization([{ name: "managed", source: "user", scope: "managed" }, { name: "other", scope: "other" }])).toMatchObject({ kind: "ok", value: { skills: 0 } });
  expect(await customization([])).toMatchObject({ kind: "ok", value: { skills: 0 } });
});

test("commands, MCP servers and tools still use source and do not inherit the skill scope rule", async () => {
  const named = { name: "mine", id: "mine", source: "user", scope: "project" as const };
  expect(await customization([{ name: "skill", scope: "user" }], {
    commands: async () => catalog([named]), mcpServers: async () => ({ ...catalog([]), items: [named] }), tools: async () => catalog([named]),
  })).toMatchObject({ kind: "ok", value: { skills: 1, commands: 1, mcpServers: 1, tools: 1 } });
  const unknown = { ...named, source: "personal", scope: "user" as const };
  expect(await customization([], {
    commands: async () => catalog([unknown]), mcpServers: async () => ({ ...catalog([]), items: [unknown] }), tools: async () => catalog([unknown]),
  })).toMatchObject({ kind: "ok", value: { skills: 0 } });
});

test.each(["context", "mcp-only"] as const)("%s catalogs remain omitted even with known scopes", async view => {
  expect(await customization([], { skills: async () => ({ ...catalog([{ name: "mine", scope: "user" }]), view }) })).toEqual({ kind: "unsupported" });
});

test("known scopes do not make a partial inventory countable", async () => {
  expect(await customization([], { skills: async () => ({ ...catalog([{ name: "mine", scope: "user" }]), partial: true }) })).toMatchObject({ kind: "failed" });
});
