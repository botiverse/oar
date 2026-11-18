import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";

test.skipIf(process.env.OAR_TEST !== "antigravity-file-skills")("file catalog matches the pinned native skills command", { timeout: 120_000 }, async () => {
  const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "antigravity-file-skills", "comparison.json");
  // Use Node's module loader too: Vitest can hide invalid CommonJS named imports.
  const result = await runExecutable(process.execPath, ["--import", "tsx", resolve("experiments/antigravity-file-skills/probe.ts"), output], { timeoutMs: 115_000 });
  assert.ok(result.ok, result.stderr || result.stdout);
});
