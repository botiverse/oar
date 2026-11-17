/** Validate the signed-in probe machinery against a native CLI with synthetic configuration. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { asRecordList } from "../../packages/oar/src/shared/json.js";
import { probeRealMenus } from "./probe.js";

const [command, output] = process.argv.slice(2);
assert.ok(command !== undefined && output !== undefined, "Usage: local-control.ts /absolute/agy output.json");
const fixture = await startAntigravityAimock(() => {});
try {
  const directory = fixture.env.HOME;
  assert.ok(directory !== undefined, "The local fixture must supply an isolated HOME");
  const report = await probeRealMenus(path.resolve(command), directory, { PATH: process.env.PATH, ...fixture.env });
  const { phases, ...fields } = report;
  const captured = asRecordList(phases);
  const selected = { ...fields, provider: "isolated local Gemini provider, synthetic credential", providerRequests: fixture.raw.length,
    phaseChanges: captured.map(phase => ({ phase: phase.phase, changesSincePrevious: phase.changesSincePrevious })),
    finalFiles: captured.at(-1)?.files };
  await writeFile(output, `${JSON.stringify(selected, null, 2)}\n`);
  assert.equal(fixture.raw.length, 0);
  assert.equal(report.failure, null);
  assert.deepEqual(report.restoration, { model: true, effort: true });
} finally { await fixture.stop(); }
