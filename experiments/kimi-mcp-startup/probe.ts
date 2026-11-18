/* oxlint-disable no-await-in-loop -- Each fresh process is an independent ordered control. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { runKimiCatalog, type KimiCatalogOptions } from "../../sea-trial/vendor/support/kimi-mcp-catalog.js";

const [command, output] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command) && output !== undefined,
  "Usage: pnpm tsx experiments/kimi-mcp-startup/probe.ts <absolute kimi binary> <new output directory>");
const directory = path.resolve(output);
await mkdir(directory, { recursive: false, mode: 0o700 });
const installation = await kimiRuntime.installation({ env: { OAR_KIMI_BIN: command } });
assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
process.env.OAR_TRIAL_RUN_DIR = directory;
const cases: readonly KimiCatalogOptions[] = [
  { mode: "cold-native", delayMs: 0 },
  { mode: "cold-native", delayMs: 1000 },
  { mode: "prepared-native", delayMs: 0 },
];
const summaries = [];
for (const options of cases) {
  const run = await runKimiCatalog(installation, options);
  const { frames, provider, ...facts } = run;
  const label = `${options.mode}-${String(options.delayMs)}`;
  await writeFile(path.join(directory, `${label}.raw.json`), JSON.stringify({ frames, provider }, null, 2));
  const summary = { version: installation.version, platform: process.platform, ...facts };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
await writeFile(path.join(directory, "summary.json"), JSON.stringify(summaries, null, 2));
