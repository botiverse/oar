import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeRegistry, defineRuntime } from "../src/index.js";

test("registry preserves one canonical runtime per id", () => {
  const alpha = defineRuntime({ id: "alpha" });
  const registry = new RuntimeRegistry([alpha]);
  assert.equal(registry.require("alpha"), alpha);
  assert.deepEqual(registry.list(), [alpha]);
  assert.throws(() => new RuntimeRegistry([alpha, alpha]), /duplicate runtime id/u);
});
