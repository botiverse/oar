import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGrokModelsOutput } from "./grok.js";
import { parseAgyModelsOutput } from "./antigravity.js";
import { parseOpencodeModelsOutput } from "./opencode.js";
import { parseCodexModelsCache } from "./codex.js";
import { parseKimiCodeConfigToml } from "./kimi.js";
import {
  buildClaudeModels,
  defaultClaudeModelIds,
  CLAUDE_API_MODELS,
  CLAUDE_ALIASES,
} from "./claude.js";

const fixtures = join(import.meta.dirname, "fixtures");

function load(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

test("grok models fixture → ids (login noise kept in fixture)", () => {
  const text = load("grok-models.sample.txt");
  assert.match(text, /logged in/i);
  assert.deepEqual(parseGrokModelsOutput(text), ["grok-4.5"]);
});

test("agy models live fixture (glued id+label)", () => {
  const rows = parseAgyModelsOutput(load("agy-models.sample.txt"));
  assert.ok(rows.length >= 10);
  assert.equal(rows[0]!.id, "gemini-3.6-flash-high");
  assert.equal(rows[0]!.label, "Gemini 3.6 Flash (High)");
  assert.ok(rows.some((r) => r.id === "claude-opus-4-6-thinking"));
});

test("agy models spaced fixture (xxchan sample)", () => {
  const rows = parseAgyModelsOutput(load("agy-models-spaced.sample.txt"));
  assert.equal(rows[0]!.id, "gemini-3.6-flash-high");
  assert.equal(rows[0]!.label, "Gemini 3.6 Flash (High)");
  assert.equal(rows.length, 11);
});

test("opencode models fixture drops warning noise", () => {
  const ids = parseOpencodeModelsOutput(load("opencode-models.sample.txt"));
  assert.ok(ids.includes("opencode/big-pickle"));
  assert.ok(ids.every((id) => id.includes("/")));
  assert.ok(!ids.some((id) => /warning|at /i.test(id)));
});

test("codex models_cache fixture → list + user-configured, drops hidden", () => {
  const raw = JSON.parse(load("codex-models_cache.sample.json")) as Parameters<
    typeof parseCodexModelsCache
  >[0];
  const { models, hadNonList } = parseCodexModelsCache(raw);
  assert.equal(hadNonList, true);
  assert.equal(models[0]!.id, "gpt-5.6-sol");
  assert.ok(models.some((m) => m.id === "user-configured"));
  assert.ok(!models.some((m) => m.id === "hidden-model"));
});

test("kimi config.toml fixture → models + efforts", () => {
  const { models, defaultModel } = parseKimiCodeConfigToml(load("kimi-config.sample.toml"));
  assert.equal(defaultModel, "kimi-code/k3");
  assert.equal(models.length, 2);
  assert.equal(models[1]!.label, "K3");
  assert.deepEqual(models[1]!.supportedReasoningEfforts, ["low", "high", "max"]);
});

test("claude models fixture lists aliases + API ids + user-configured", () => {
  const fixtureIds = load("claude-models.sample.txt")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const catalog = buildClaudeModels();
  const catalogIds = new Set(catalog.map((m) => m.id));
  for (const id of fixtureIds) {
    assert.ok(catalogIds.has(id), `missing ${id}`);
  }
  assert.ok(catalog.some((m) => m.id === "user-configured"));
  assert.equal(catalog.find((m) => m.id === "user-configured")!.options.length, 0);
  // No-op [1m] suffixes omitted from create-form (product: xxchan + Huaihuai).
  assert.ok(!catalogIds.has("sonnet[1m]"));
  assert.ok(!catalogIds.has("opus[1m]"));
  assert.ok(!catalogIds.has("fable[1m]"));
  // Full Anthropic IDs present (raft RUNTIME_MODELS.claude shape)
  assert.ok(catalogIds.has("claude-opus-5"));
  assert.ok(catalogIds.has("claude-fable-5"));
  assert.ok(CLAUDE_API_MODELS.length >= 8);
  assert.ok(CLAUDE_ALIASES.some((a) => a.id === "opus"));
  assert.ok(defaultClaudeModelIds().includes("claude-sonnet-5"));
});

test("claude CLAUDE_MODEL_LIST extra ids are appended", () => {
  const models = buildClaudeModels(["claude-custom-gateway-model"]);
  assert.ok(models.some((m) => m.id === "claude-custom-gateway-model"));
  assert.ok(models.some((m) => m.id === "user-configured"));
});
