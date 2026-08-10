import assert from "node:assert/strict";
import test from "node:test";
import { optionsBranch } from "../../../config/model.js";
import {
  CODEX_USER_CONFIGURED,
  parseCodexModelsCache,
} from "./codex.js";

test("cache with only non-list visibility yields user-configured", () => {
  const { models, hadNonList } = parseCodexModelsCache({
    models: [
      { slug: "secret-model", display_name: "Secret", visibility: "hidden" },
    ],
  });
  assert.equal(hadNonList, true);
  assert.ok(models.some((m) => m.id === "user-configured"));
  assert.equal(models.find((m) => m.id === "secret-model"), undefined);
});

test("cache with list models appends user-configured", () => {
  const { models } = parseCodexModelsCache({
    models: [
      {
        slug: "gpt-5",
        display_name: "GPT-5",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
    ],
  });
  assert.equal(models[0]?.id, "gpt-5");
  assert.ok(models.some((m) => m.id === "user-configured"));
});

test("empty models array still emits user-configured (not bare [])", () => {
  const { models } = parseCodexModelsCache({ models: [] });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "user-configured");
});

test("user-configured has zero options (supported⇒required invariant)", () => {
  assert.equal(CODEX_USER_CONFIGURED.options.length, 0);
  const branch = optionsBranch(CODEX_USER_CONFIGURED.options);
  assert.equal(branch.required.length, 0);
  assert.deepEqual(branch.properties, {});
});

test("user-configured options must not invent caps (tooth c)", () => {
  // Mutation guard: if someone later stuffs a default option onto the sentinel,
  // supported⇒required would make create-form force-fill it — that must fail.
  assert.equal(CODEX_USER_CONFIGURED.options.length, 0);
});
