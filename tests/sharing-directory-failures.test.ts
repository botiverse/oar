/* oxlint-disable max-statements -- Build simultaneous failures and inspect their complete diagnostic list. */
import assert from "node:assert/strict";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { expect, it } from "vitest";
import { directoryFailureReasons } from "../experiments/sharing/directory-failures.js";

function completeReport(): JsonRecord {
  return { runtime: "opencode", configurationComparison: { projectMarkersMatch: true, hookRevisionsMatch: true },
    cohorts: ["shared", "separate"].map((mode) => ({ mode, observed: true, isolated: true,
      turns: ["A_mcpbefore", "B_mcpafter", "A_mcpafter", "A_mcptogether", "B_mcptogether"].map((input) => ({ input, isolated: true })),
      releasedDirectory: { observed: true, retainedMcpInvoked: false, afterARelease: { isolated: true }, finalSurvivorInvocation: { isolated: true } },
    })) };
}

it("reports coverage gaps, native crossover and cleanup errors together", () => {
  const report = completeReport();
  report.configurationComparison = { projectMarkersMatch: true, hookRevisionsMatch: null };
  assert.ok(Array.isArray(report.cohorts));
  const shared = asRecord(report.cohorts[0]);
  assert.ok(shared);
  shared.isolated = false;
  shared.error = "AggregateError: observation and cleanup: native stop failed";
  assert.ok(Array.isArray(shared.turns));
  const turn = asRecord(shared.turns[2]);
  const released = asRecord(shared.releasedDirectory);
  assert.ok(turn && released);
  turn.isolated = false;
  released.retainedMcpInvoked = true;
  shared.turns[2] = turn; shared.releasedDirectory = released; report.cohorts[0] = shared;
  expect(directoryFailureReasons(report)).toEqual(expect.arrayContaining([
    "configuration: missing evidence for hook revisions",
    "shared/A_mcpafter: MCP invocation or native result mismatch",
    "shared: old MCP server invoked after release and empty-MCP reopen",
    'shared: "AggregateError: observation and cleanup: native stop failed"',
  ]));
});

it("accepts only complete, matching evidence and includes all failed configuration controls", () => {
  const report = completeReport();
  expect(directoryFailureReasons(report)).toEqual([]);
  report.runtime = "kimi";
  report.configurationFollowup = [{ scenario: "alive_same_directory", mode: "shared", observed: false, error: "missing B invocation" }];
  report.configurationFollowupComparison = [{ scenario: "alive_same_directory", projectMarkersMatch: null, hookRevisionsMatch: false }];
  expect(directoryFailureReasons(report)).toEqual(expect.arrayContaining([
    "missing evidence: expected all Kimi configuration controls",
    'alive_same_directory/shared: "missing B invocation"',
    "alive_same_directory: missing evidence for project instruction markers",
    "alive_same_directory: hook revisions differ between shared and fresh processes",
  ]));
});

it("does not accept missing or differing Codex hook-trust controls", () => {
  const report = completeReport(); report.runtime = "codex";
  expect(directoryFailureReasons(report)).toEqual(expect.arrayContaining([
    "missing evidence: expected both directions of Codex hook-trust controls",
    "hook trust/trusted_then_untrusted: missing evidence for project instruction markers",
    "hook trust/untrusted_then_trusted: missing evidence for hook revisions",
  ]));
  const scenarios = ["untrusted_then_trusted", "trusted_then_untrusted"];
  report.trustFollowup = scenarios.flatMap((scenario) => ["shared", "separate"].map((mode) => ({ scenario, mode, observed: true })));
  report.trustFollowupComparison = scenarios.map((scenario) => ({ scenario, projectMarkersMatch: true, hookRevisionsMatch: true }));
  expect(directoryFailureReasons(report)).toEqual([]);
  report.trustFollowupComparison = scenarios.map((scenario) => ({ scenario, projectMarkersMatch: true, hookRevisionsMatch: scenario !== "trusted_then_untrusted" }));
  expect(directoryFailureReasons(report)).toEqual(["hook trust/trusted_then_untrusted: hook revisions differ between shared and fresh processes"]);
});
