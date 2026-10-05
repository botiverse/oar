import assert from "node:assert/strict";
import { test } from "vitest";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import { RuntimeRegistry, defineRuntime, defaultRuntimes } from "../packages/oar/src/index.js";

test("registry preserves one canonical runtime per id", () => {
  const alpha = defineRuntime({ id: "alpha", session: startMockSession });
  const registry = new RuntimeRegistry([alpha]);
  assert.equal(registry.require("alpha"), alpha);
  assert.deepEqual(registry.list(), [alpha]);
  assert.throws(() => new RuntimeRegistry([alpha, alpha]), /duplicate runtime id/u);
});

test("built-in registry exposes concrete ACP runtimes, not a generic ACP identity", () => {
  assert.deepEqual(defaultRuntimes.list().map((runtime) => runtime.id), [
    "antigravity",
    "claude",
    "codex",
    "grok",
    "kimi",
    "pi",
  ]);
  assert.equal(defaultRuntimes.get("acp"), undefined);
});
