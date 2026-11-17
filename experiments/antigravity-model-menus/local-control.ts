/** Validate the signed-in probe machinery against a native CLI with synthetic configuration. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { probeMenuPersistence } from "./paired-probe.js";

function selectedRun(report: JsonRecord): JsonRecord {
  const { phases, ...fields } = report;
  const captured = asRecordList(phases);
  return { ...fields, provider: "isolated local Gemini provider, synthetic credential",
    phaseChanges: captured.map(phase => ({ phase: phase.phase, changesSincePrevious: phase.changesSincePrevious })),
    finalFiles: captured.at(-1)?.files };
}

const [command, output] = process.argv.slice(2);
assert.ok(command !== undefined && output !== undefined, "Usage: local-control.ts /absolute/agy output.json");
const fixture = await startAntigravityAimock(() => {});
try {
  const home = fixture.env.HOME;
  assert.ok(home !== undefined, "The local fixture must supply an isolated HOME");
  const directory = path.join(home, "workspace");
  await mkdir(directory);
  const report = await probeMenuPersistence(path.resolve(command), directory, { PATH: process.env.PATH, ...fixture.env });
  const selected = { ...report, providerRequests: fixture.raw.length, baseline: selectedRun(report.baseline),
    switches: report.switches === null ? null : selectedRun(report.switches) };
  await writeFile(output, `${JSON.stringify(selected, null, 2)}\n`);
  assert.equal(fixture.raw.length, 0);
  assert.equal(report.baseline.failure, null);
  assert.equal(report.switches?.failure, null);
  assert.deepEqual(report.switches.restoration, { model: true, effort: true });
  assert.notEqual(report.persistence?.status, "inconclusive");
  assert.notEqual(asRecord(report.persistence?.restoration)?.confirmed, false);
} finally { await fixture.stop(); }
