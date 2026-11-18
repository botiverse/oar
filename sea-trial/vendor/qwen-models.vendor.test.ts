import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";

test.skipIf(process.env.OAR_TEST !== "qwen-aimock")("model listing distinguishes native authentication refusal, empty and configured catalogs", async () => {
  const installation = await qwenRuntime.installation();
  assert.equal(installation.kind, "available");
  assert.equal(installation.via, "executable");
  const observations = [];
  for (const mode of ["signed-out", "empty", "configured"] as const) {
    const fixture = await startQwenAimock();
    try {
      const home = path.dirname(fixture.cwd);
      const config = path.join(home, ".qwen/settings.json");
      if (mode !== "configured") { await rm(config); }
      const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...fixture.env,
        PATH: process.env.PATH ?? "", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
        ...(mode === "signed-out" ? { OPENAI_API_KEY: null, OPENAI_BASE_URL: null, OPENAI_MODEL: null } : {}),
      };
      const result = await qwenRuntime.listModels(installation, { cwd: fixture.cwd, env });
      observations.push({ mode, result, modelRequests: fixture.raw.length });
      if (mode === "signed-out") { expect(result).toEqual({ kind: "unauthenticated", detail: "Configure a Qwen authentication type before listing models." }); }
      else if (mode === "empty") { expect(result).toEqual({ kind: "ok", models: [] }); }
      else {
        expect(result).toEqual({ kind: "ok", models: [
          { id: "gpt-5.1", displayName: "Local reasoning model", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
        ] });
      }
      expect(fixture.raw).toEqual([]);
    } finally { await fixture.stop(); }
  }
  const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "qwen-models");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "results.json"), JSON.stringify({ version: installation.version, observations }, null, 2));
}, 90_000);
