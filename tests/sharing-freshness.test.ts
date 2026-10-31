import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { freshnessCohortFailures, freshnessComparisons, freshnessFailureReasons, freshnessScenarios } from "../experiments/sharing/configuration-freshness-checks.js";

function cohort(scenario: string, mode: string): JsonRecord {
  const grant = scenario === "native_trust_grant";
  return { scenario, mode, runtime: "grok", observed: true, distinctCanonicalDirectories: !grant, observedProcessAliveDuringGrant: true,
    trustGrants: Array.from({ length: grant ? 1 : 2 }, () => ({ initialized: true, storeChanged: true, trustedEntryPresent: true })),
    turns: ["A_mcpfreshbefore", "B_mcpfreshafter", "A_mcpfreshlater"].map((input, index) => ({ input,
      nativeOutputRetained: true, finalInvocation: { isolated: true },
      directoryRuleMarkers: { initial: !grant && index === 0, changed: index > 0 },
    })),
    directoryConfiguration: { hooks: [
      ...grant ? [] : [{ revision: "A", event: { tool_input: { text: "A_mcpfreshbefore" } } }],
      { revision: "B", event: { tool_input: { text: "B_mcpfreshafter" } } },
    ] } };
}

it.each(freshnessScenarios("grok"))("accepts complete positive and negative controls for %s", (scenario) => {
  expect(freshnessCohortFailures(cohort(scenario, "shared"))).toEqual([]);
});

it("does not equate two empty or equally stale B observations with fresh configuration", () => {
  for (const hooks of [[], [{ revision: "A", event: { tool_input: { text: "B_mcpfreshafter" } } }]]) {
    const rows = ["shared", "separate"].map((mode) => Object.assign(cohort("native_trust_grant", mode), { directoryConfiguration: { hooks } }));
    expect(freshnessComparisons("grok", rows)[0]?.passed).toBe(false);
  }
});

it("requires the external grant, a live observed process, and a real distinct-directory control", () => {
  const original = cohort("different_directory_user_hooks", "shared");
  for (const patch of [{ trustGrants: [] }, { distinctCanonicalDirectories: false }, { observedProcessAliveDuringGrant: false }]) {
    expect(freshnessCohortFailures({ ...original, ...patch }).length).toBeGreaterThan(0);
  }
});

it("does not count untrusted hook absence when the baseline tool did not run", () => {
  const row = cohort("native_trust_grant", "shared");
  row.turns = [];
  expect(freshnessCohortFailures(row)).toContain("missing evidence: A_mcpfreshbefore must call its own MCP exactly once and retain its result");
});

it.each(["instructions", "hook"])("rejects an untrusted A baseline that observes project %s", (kind) => {
  const row = cohort("native_trust_grant", "shared");
  if (kind === "instructions") {
    assert.ok(Array.isArray(row.turns));
    const first = asRecord(row.turns[0]); assert.ok(first);
    first.directoryRuleMarkers = { initial: true, changed: false }; row.turns[0] = first;
  } else {
    row.directoryConfiguration = { hooks: [
      { revision: "A", event: { tool_input: { text: "A_mcpfreshbefore" } } },
      { revision: "B", event: { tool_input: { text: "B_mcpfreshafter" } } },
    ] };
  }
  expect(freshnessCohortFailures(row)).toContain("untrusted baseline must omit project instructions and project hooks");
});

it("includes shared versus fresh-process differences in the final failure reasons", () => {
  const shared = cohort("native_trust_grant", "shared");
  shared.directoryConfiguration = { hooks: [{ revision: "A", event: { tool_input: { text: "B_mcpfreshafter" } } }] };
  const comparisons = freshnessComparisons("grok", [shared, cohort("native_trust_grant", "separate")]);
  expect(freshnessFailureReasons(comparisons)).toContain("native_trust_grant: shared and fresh-process configuration differs (instruction markers match: true, hook revisions match: false)");
});

it("does not let OpenCode project discovery stand in for user-configuration refresh", () => {
  const rows = ["shared", "separate"].map((mode) => Object.assign(cohort("different_directory", mode), { runtime: "opencode" }));
  const comparisons = freshnessComparisons("opencode", rows);
  expect(comparisons.find((comparison) => comparison.scenario === "different_directory")?.passed).toBe(true);
  expect(comparisons.find((comparison) => comparison.scenario === "different_directory_user_configuration")?.passed).toBe(false);
});
