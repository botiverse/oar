import { resolve } from "node:path";
import { test } from "vitest";
import { compareAntigravityFileSkills } from "./support/antigravity-file-skills.js";

test.skipIf(process.env.OAR_TEST !== "antigravity-file-skills")("file catalog matches the pinned native skills command", { timeout: 120_000 }, async () => {
  await compareAntigravityFileSkills(resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "antigravity-file-skills", "comparison.json"));
});
