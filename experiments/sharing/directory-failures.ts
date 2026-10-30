/** List every failed boundary; missing coverage must not conceal a native defect. */
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const rows = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map((row) => asRecord(row)).filter((row) => row !== null) : [];

function configurationFailures(comparison: JsonRecord | null, label: string): string[] {
  const failures: string[] = [];
  for (const [field, name] of [["projectMarkersMatch", "project instruction markers"], ["hookRevisionsMatch", "hook revisions"]] as const) {
    const matches = comparison?.[field];
    if (matches === false) { failures.push(`${label}: ${name} differ between shared and fresh processes`); }
    else if (matches !== true) { failures.push(`${label}: missing evidence for ${name}`); }
  }
  return failures;
}

function cohortFailures(row: JsonRecord): string[] {
  const label = String(row.mode);
  const failures: string[] = [];
  if (row.error !== undefined) { failures.push(`${label}: ${JSON.stringify(row.error)}`); }
  if (row.observed !== true) { failures.push(`${label}: observation incomplete`); }
  if (row.isolated !== true) { failures.push(`${label}: native MCP isolation failed or was not established`); }
  const turns = rows(row.turns);
  if (turns.length !== 5) { failures.push(`${label}: missing evidence for the complete five-turn comparison`); }
  for (const turn of turns) {
    if (turn.error !== undefined) { failures.push(`${label}/${String(turn.input)}: ${JSON.stringify(turn.error)}`); }
    if (turn.isolated !== true) { failures.push(`${label}/${String(turn.input)}: MCP invocation or native result mismatch`); }
  }
  const released = asRecord(row.releasedDirectory);
  if (released?.observed !== true) { failures.push(`${label}: missing evidence for the release comparison`); }
  if (released?.retainedMcpInvoked === true) { failures.push(`${label}: old MCP server invoked after release and empty-MCP reopen`); }
  if (released?.observed === true && (asRecord(released.afterARelease)?.isolated !== true || asRecord(released.finalSurvivorInvocation)?.isolated !== true)) {
    failures.push(`${label}: survivor MCP invocation failed after peer release`);
  }
  return failures;
}

export function directoryFailureReasons(report: JsonRecord): string[] {
  const failures: string[] = [];
  const cohorts = rows(report.cohorts);
  for (const mode of ["shared", "separate"]) {
    const matching = cohorts.filter((row) => row.mode === mode);
    if (matching.length !== 1) { failures.push(`missing evidence: expected one ${mode} cohort`); }
    for (const row of matching) { failures.push(...cohortFailures(row)); }
  }
  if (cohorts.length !== 2) { failures.push("expected exactly two comparison cohorts"); }
  failures.push(...configurationFailures(asRecord(report.configurationComparison), "configuration"));
  if (report.runtime === "kimi") {
    const followup = rows(report.configurationFollowup);
    const comparisons = rows(report.configurationFollowupComparison);
    if (followup.length !== 6 || comparisons.length !== 3) { failures.push("missing evidence: expected all Kimi configuration controls"); }
    for (const row of followup) {
      const label = `${String(row.scenario)}/${String(row.mode)}`;
      if (row.error !== undefined) { failures.push(`${label}: ${JSON.stringify(row.error)}`); }
      if (row.observed !== true) { failures.push(`${label}: configuration observation incomplete`); }
    }
    for (const comparison of comparisons) { failures.push(...configurationFailures(comparison, String(comparison.scenario))); }
  }
  if (report.runtime === "codex") {
    const trust = rows(report.trustFollowup);
    if (trust.length !== 2) { failures.push("missing evidence: expected both Codex hook-trust controls"); }
    for (const row of trust) {
      if (row.error !== undefined) { failures.push(`hook trust/${String(row.mode)}: ${JSON.stringify(row.error)}`); }
      if (row.observed !== true) { failures.push(`hook trust/${String(row.mode)}: observation incomplete`); }
    }
    failures.push(...configurationFailures(asRecord(report.trustFollowupComparison), "hook trust"));
  }
  return failures;
}
