/** Manual-only admission evidence; no runtime sharing is enabled here. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { freshnessComparisons, freshnessScenarios } from "./configuration-freshness-checks.js";
import { observeConfigurationFreshness } from "./configuration-freshness-observe.js";
import { recordProcessTableReads } from "./process-table.js";

const runtime = process.argv[2] ?? "grok"; assert.ok(runtime === "grok" || runtime === "opencode");
const out = path.resolve(process.argv[3] ?? `oar-trial-run/configuration-freshness-${runtime}`);
await mkdir(out, { recursive: true });
recordProcessTableReads(path.join(out, "process-table-reads.jsonl"));
prepareWindowsProcessTable(path.join(out, "windows-process-table-preparation.jsonl"));
const cohorts: JsonRecord[] = [];
const report: JsonRecord = { runtime, at: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  settlingMs: 3000, scope: "Native persisted trust grant with A alive, and later B in another directory, compared with a fresh process", cohorts };
for (const scenario of freshnessScenarios(runtime)) {
  for (const mode of ["shared", "separate"] as const) {
    // oxlint-disable-next-line no-await-in-loop -- Each cohort owns fresh homes and native processes; do not overlap controls.
    const row = await observeConfigurationFreshness(runtime, scenario, mode); cohorts.push(row);
    process.stdout.write(`${runtime}/${scenario}/${mode}: ${JSON.stringify({ observed: row.observed, error: row.error })}\n`);
    // oxlint-disable-next-line no-await-in-loop -- Preserve every cohort before opening the next one.
    await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
}
const comparisons = freshnessComparisons(runtime, cohorts); report.comparisons = comparisons;
await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
assert.ok(comparisons.every((comparison) => comparison.passed === true), `configuration freshness incomplete or different; inspect ${out}/evidence.json`);
