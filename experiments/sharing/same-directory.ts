/* oxlint-disable import/max-dependencies -- Manual probe composes lifecycle, native protocol and evidence writers. */
/** Same cwd, same MCP name, different configuration. No runtime is enabled. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { preservingProbeEvidence, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";
import { auditFinalInvocations, invocationEvidence } from "./mcp-scope.js";
import { ProbeTiming } from "./observation.js";
import { recordProcessTableReads } from "./process-table.js";
import { directoryFixture, type DirectorySession, type Label, type ConnectionMode } from "./same-directory-fixture.js";
import { compareDirectoryConfiguration, directoryRuleMarkers } from "./directory-configuration.js";
import { codexHookTrustObservations, compareCodexHookTrust, trustScenarios } from "./codex-hook-trust.js";
import { kimiConfigurationObservations } from "./kimi-configuration.js";
import { nativeHookCompletions, nativeContextShells } from "./hook-completions.js";
import { directoryFailureReasons } from "./directory-failures.js";

const runtime = process.argv[2] ?? "opencode";
assert.ok(["codex", "kimi", "grok", "opencode", "antigravity", "qoder"].includes(runtime));
const out = path.resolve(process.argv[3] ?? `oar-trial-run/same-directory-${runtime}`);
await mkdir(out, { recursive: true });
recordProcessTableReads(path.join(out, "process-table-reads.jsonl"));
prepareWindowsProcessTable(path.join(out, "windows-process-table-preparation.jsonl"));
const report: JsonRecord = { runtime, at: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  scope: "Same canonical directory, same MCP server name scope, different command arguments; sequential then concurrent invocation",
  settlingMs: 3000, cohorts: [] };
const cohorts: JsonRecord[] = []; report.cohorts = cohorts;

async function observe(mode: ConnectionMode): Promise<void> {
  const timing = new ProbeTiming();
  const row: JsonRecord = { mode, waits: timing.waits, observed: false, isolated: false };
  cohorts.push(row);
  await usingProbeFixture(async () => { const fixture = await directoryFixture(runtime, mode, timing); return fixture; }, async (fixture) => {
    row.installation = fixture.installation; row.cwd = fixture.cwd;
    const turns: JsonRecord[] = []; row.turns = turns;
    const invoke = async (session: DirectorySession, label: Label, phase: string): Promise<void> => {
      const input = `${label}_mcp${phase}`;
      const turn: JsonRecord = { input, sessionId: session.id }; turns.push(turn);
      try {
        const { response, output } = await session.invoke(input);
        const invocation = invocationEvidence(await fixture.calls(), input, label);
        const nativeOutputRetained = invocation.calls.length === 1 && output.includes(invocation.calls[0]?.output ?? "");
        Object.assign(turn, { response, output, invocation, nativeOutputRetained, directoryRuleMarkers: directoryRuleMarkers(output), isolated: invocation.isolated && nativeOutputRetained });
      } catch (error) { turn.error = probeErrorText(error); turn.isolated = false; }
      process.stdout.write(`${runtime}/${mode}/${input}: ${JSON.stringify({ isolated: turn.isolated, error: turn.error, invocation: turn.invocation })}\n`);
    };
    await preservingProbeEvidence(async () => {
      await fixture.configuration.setRevision("A");
      const a = await fixture.open("A"); row.a = a.id;
      // A fixed, recorded settling period is not a retry or proof of catalog readiness.
      // A missing tool still fails; B's first invocation precedes A's second invocation.
      await timing.measure("catalog settling before A baseline", 3000, async () => { await delay(3000); });
      await invoke(a, "A", "before");
      await fixture.configuration.setRevision("B");
      const b = await fixture.open("B"); row.b = b.id; assert.notEqual(a.id, b.id);
      await timing.measure("catalog settling after B open", 3000, async () => { await delay(3000); });
      await invoke(b, "B", "after");
      await invoke(a, "A", "after");
      await Promise.all([invoke(a, "A", "together"), invoke(b, "B", "together")]);
      row.observed = true;
      row.isolated = turns.length === 5 && turns.every((turn) => turn.isolated === true);
      {
        const released = await fixture.releasedDirectory(); row.releasedDirectory = released;
        if (released.observed !== true || released.retainedMcpInvoked === true || asRecord(released.afterARelease)?.isolated !== true) { row.isolated = false; }
        process.stdout.write(`${runtime}/${mode}/released-directory: ${JSON.stringify({ retainedMcpInvoked: released.retainedMcpInvoked, calls: released.calls })}\n`);
      }
    }, [
      async (): Promise<void> => { row.directoryConfiguration = await fixture.configuration.evidence(); },
      async (): Promise<void> => { const allCalls = await fixture.calls(); row.mcpInvocations = allCalls; auditFinalInvocations(row, allCalls); },
      (): void => { row.native = fixture.evidence(); row.nativeHookCompletions = nativeHookCompletions(row.native); row.nativeContextShells = nativeContextShells(row.native); },
    ]);
  });
}

for (const mode of ["shared", "separate"] as const) {
  // oxlint-disable-next-line no-await-in-loop -- The control uses a fresh fixture after the shared cohort has stopped.
  try { await observe(mode); } catch (error) { const row = cohorts.at(-1); assert.ok(row); row.error = probeErrorText(error); row.observed = false; row.isolated = false; }
  // oxlint-disable-next-line no-await-in-loop -- Retain partial evidence even if the next cohort fails.
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (runtime === "kimi") {
  const followup = await kimiConfigurationObservations();
  report.configurationFollowup = followup;
  const comparisons = ["alive_same_directory", "different_directory", "closed_same_directory"].map((scenario): JsonRecord => {
    const shared = followup.find((row) => row.scenario === scenario && row.mode === "shared");
    const separate = followup.find((row) => row.scenario === scenario && row.mode === "separate");
    assert.ok(shared !== undefined && separate !== undefined);
    const comparison = compareDirectoryConfiguration(shared, separate, "B_mcpfreshafter");
    comparison.scenario = scenario;
    return comparison;
  });
  report.configurationFollowupComparison = comparisons;
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (runtime === "codex") {
  const trust = await codexHookTrustObservations(); report.trustFollowup = trust;
  report.trustFollowupComparison = trustScenarios.map((scenario) => {
    const sharedTrust = trust.find((row) => row.scenario === scenario && row.mode === "shared");
    const separateTrust = trust.find((row) => row.scenario === scenario && row.mode === "separate");
    assert.ok(sharedTrust && separateTrust);
    return compareCodexHookTrust(sharedTrust, separateTrust);
  });
}
const [shared, separate] = cohorts;
assert.ok(shared !== undefined && separate !== undefined);
const comparison = compareDirectoryConfiguration(shared, separate);
report.configurationComparison = comparison;
report.missingEvidence = comparison.missingEvidence === true || [report.trustFollowupComparison, report.configurationFollowupComparison]
  .some((comparisons) => Array.isArray(comparisons) && comparisons.some((entry) => asRecord(entry)?.missingEvidence === true));
const failures = directoryFailureReasons(report); report.failureReasons = failures;
await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
assert.equal(failures.length, 0, `${failures.join("\n")}; inspect evidence.json`);
