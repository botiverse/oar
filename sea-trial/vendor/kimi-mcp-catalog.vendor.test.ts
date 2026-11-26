import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { versionAtLeast } from "../../packages/oar/src/shared/update.js";
import { runKimiCatalog } from "./support/kimi-mcp-catalog.js";
import { ALPHA } from "./support/tools-list-changed.js";

for (const mode of ["prepared-native", "cold-oar"] as const) {
  test.skipIf(process.env.OAR_TEST !== "kimi-aimock")(`Kimi ${mode} MCP catalog matches native discovery and notification behavior`, { timeout: 120_000 }, async () => {
    const installation = await kimiRuntime.installation();
    assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
    assert.ok(installation.version !== undefined && /^\d+\.\d+\.\d+$/u.test(installation.version), "Catalog control requires a native release version");
    const run = await runKimiCatalog(installation, { mode, delayMs: mode === "prepared-native" ? 0 : 1000 });
    const output = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "kimi-mcp-catalog");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, `${mode}.json`), JSON.stringify({ version: installation.version, ...run }, null, 2));
    const why = JSON.stringify({ version: installation.version, log: run.log, marks: run.marks, turns: run.turns });
    expect(run.log, why).toContain("tools/list");
    expect(run.relisted, why).toBe(false);
    expect(kimiRuntime.mcpToolsListChanged).toBe("none");
    // Kimi 2.8.0 fixed the cold-start snapshot: https://github.com/MoonshotAI/kimi-code/pull/5240
    const omitted = mode === "cold-oar"
      && versionAtLeast(installation.version, "2.6.0")
      && !versionAtLeast(installation.version, "2.8.0");
    expect(run.turns, why).toEqual([[omitted ? [] : [ALPHA]], [omitted ? [] : [ALPHA]]]);
  });
}
