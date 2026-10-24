/** Run with OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-native/priority.ts. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";
import { priorityScenario, type PriorityReport } from "./priority-scenario.js";

const versionHome = await startQoderNative([]);
let version = "";
try {
  const result = await runExecutable(process.env.OAR_QODER_BIN ?? "qodercli", ["--version"], {
    cwd: versionHome.options.cwd, env: sessionEnvironment(versionHome.options.env), timeoutMs: 15_000,
  });
  assert.ok(result.ok, "Qoder version query failed"); version = result.stdout.trim();
} finally { await versionHome.stop(); }
function assertReport(report: PriorityReport): void {
  const { priority, phase, capture } = report;
  const evidence = JSON.stringify(report);
  const results = report.events.filter((event) => event.type === "result");
  assert.equal(results.length, priority === "next" && phase === "tool" ? 1 : 2, evidence);
  if (priority === "now") { assert.equal(results[0]?.terminalReason, "aborted_streaming", evidence); }
  if (capture) {
    assert.equal(report.requests.length, 1, evidence);
    const [request] = report.requests; assert.ok(request !== undefined, evidence);
    assert.equal(request.initial, true, evidence); assert.equal(request.injected, true, evidence);
    if (priority === "next" && phase === "tool") { assert.equal(request.toolResult, true, evidence); }
  } else {
    assert.equal(report.finalText, true, evidence); assert.equal(results.at(-1)?.isError, false, evidence);
  }
}
const reports: PriorityReport[] = [];
const scenarios = [true, false].flatMap((capture) => (["streaming", "tool"] as const).flatMap((phase) =>
  (["now", "next"] as const).map((priority) => ({ capture, phase, priority }))));
for (const { capture, phase, priority } of scenarios) {
  // Keep cold native starts serial so these controls do not compete for resources.
  // eslint-disable-next-line no-await-in-loop
  const report = await priorityScenario(priority, phase, capture);
  assertReport(report); reports.push(report); process.stdout.write(`${JSON.stringify(report)}\n`);
}
const output = path.join("oar-trial-run", "qoder-priority"); await mkdir(output, { recursive: true });
await writeFile(path.join(output, "report.json"), `${JSON.stringify({ version, platform: process.platform, reports }, null, 2)}\n`);
