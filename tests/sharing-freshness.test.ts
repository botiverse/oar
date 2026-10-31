import { expect, it } from "vitest";
import { type JsonRecord } from "../packages/oar/src/shared/json.js";
import { freshnessCohortFailures, freshnessComparisons, freshnessScenarios } from "../experiments/sharing/configuration-freshness-checks.js";

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
