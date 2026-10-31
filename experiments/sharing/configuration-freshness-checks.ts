/** Missing observations and a bad fresh-process control cannot establish freshness. */
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { compareDirectoryConfiguration } from "./directory-configuration.js";
import { hookInputMatches } from "./directory-hooks.js";

export const freshnessScenarios = (runtime: string): readonly string[] => runtime === "grok"
  ? ["native_trust_grant", "different_directory_user_hooks", "different_directory_project_hooks"] : ["different_directory", "different_directory_user_configuration"];

export function freshnessCohortFailures(row: JsonRecord): string[] {
  const failures: string[] = [];
  const turns = Array.isArray(row.turns) ? row.turns.map(asRecord) : [];
  const configuration = asRecord(row.directoryConfiguration);
  const hooks = Array.isArray(configuration?.hooks) ? configuration.hooks.map(asRecord) : [];
  const revisions = (input: string): unknown[] => hooks.filter((hook) => hookInputMatches(hook?.event, input)).map((hook) => hook?.revision);
  for (const input of ["A_mcpfreshbefore", "B_mcpfreshafter", "A_mcpfreshlater"]) {
    const turn = turns.find((entry) => entry?.input === input);
    if (turn?.nativeOutputRetained !== true || asRecord(turn.finalInvocation)?.isolated !== true) {
      failures.push(`missing evidence: ${input} must call its own MCP exactly once and retain its result`);
    }
  }
  const a = asRecord(turns.find((turn) => turn?.input === "A_mcpfreshbefore")?.directoryRuleMarkers);
  const b = asRecord(turns.find((turn) => turn?.input === "B_mcpfreshafter")?.directoryRuleMarkers);
  if (row.scenario === "native_trust_grant") {
    if (a?.initial !== false || a.changed !== false || revisions("A_mcpfreshbefore").length > 0) {
      failures.push("untrusted baseline must omit project instructions and project hooks");
    }
  } else if (a?.initial !== true || a.changed !== false || !revisions("A_mcpfreshbefore").includes("A")) {
    failures.push("missing evidence: initial trusted A must observe instructions A and execute hook A");
  }
  if (b?.changed !== true || b.initial !== false) { failures.push("missing or stale evidence: new B must observe only instructions B"); }
  const bHooks = revisions("B_mcpfreshafter");
  if (bHooks.length === 0 || !bHooks.every((revision) => revision === "B")) { failures.push("missing or stale evidence: new B must execute only hooks B"); }
  if (row.runtime === "grok") {
    if (row.observedProcessAliveDuringGrant !== true) { failures.push("missing evidence: the observed process must remain alive during external trust grant"); }
    const grants = Array.isArray(row.trustGrants) ? row.trustGrants.map(asRecord) : [];
    const expected = row.scenario === "native_trust_grant" ? 1 : 2;
    if (grants.length !== expected || !grants.every((grant) => grant?.initialized === true && grant.storeChanged === true && grant.trustedEntryPresent === true)) {
      failures.push("missing evidence: native Grok trust grants must complete and change the disposable trust store");
    }
  }
  if (row.scenario !== "native_trust_grant" && row.distinctCanonicalDirectories !== true) {
    failures.push("missing evidence: A and B must use distinct canonical directories");
  }
  return failures;
}

function cohortComparisonFailures(row: JsonRecord): string[] {
  const failures = freshnessCohortFailures(row);
  if (row.observed !== true) { failures.push("observation incomplete"); }
  return failures;
}

export function freshnessComparisons(runtime: string, rows: readonly JsonRecord[]): JsonRecord[] {
  return freshnessScenarios(runtime).map((scenario) => {
    const shared = rows.find((row) => row.scenario === scenario && row.mode === "shared");
    const separate = rows.find((row) => row.scenario === scenario && row.mode === "separate");
    const comparison = compareDirectoryConfiguration(shared ?? {}, separate ?? {}, "B_mcpfreshafter");
    const failures = [shared, separate].flatMap((row, index) => row === undefined
      ? [`missing evidence: ${index === 0 ? "shared" : "separate"} cohort`]
      : cohortComparisonFailures(row).map((failure) => `${index === 0 ? "shared" : "separate"}: ${failure}`));
    for (const mode of ["shared", "separate"]) {
      if (rows.filter((row) => row.scenario === scenario && row.mode === mode).length !== 1) { failures.push(`missing evidence: expected exactly one ${mode} cohort`); }
    }
    if (comparison.passed !== true) { failures.push(comparison.missingEvidence === true ? "missing evidence: configuration comparison"
      : `shared and fresh-process configuration differs (instruction markers match: ${String(comparison.projectMarkersMatch)}, hook revisions match: ${String(comparison.hookRevisionsMatch)})`); }
    return Object.assign(comparison, { scenario, passed: failures.length === 0, failures });
  });
}

export function freshnessFailureReasons(comparisons: readonly JsonRecord[]): string[] {
  return comparisons.flatMap((comparison) => Array.isArray(comparison.failures)
    ? comparison.failures.map((failure) => `${String(comparison.scenario)}: ${String(failure)}`) : []);
}
