import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { kimiIssue } from "./runtime-candidate-failures.mjs";

const escape = value => String(value ?? "unknown").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll("|", "&#124;").replace(/[\r\n]/gu, " ").replaceAll("`", "&#96;");

export function candidateSummary({ key, version, os, steps, report }) {
  const valid = report?.schemaVersion === 1 && report.key === key && report.version === version && typeof version === "string"
    && Array.isArray(report.failures) && Number.isInteger(report.unclassifiedErrors) && report.unclassifiedErrors >= 0;
  const rows = [];
  if (valid) for (const failure of report.failures) {
    rows.push(`| ${failure.known?.issue === kimiIssue ? "KNOWN" : "NEW / UNCLASSIFIED"} | ${escape(failure.file)}: ${escape(failure.name)} | ${failure.known?.issue === kimiIssue ? `[issue #899](${kimiIssue})` : "Investigate; no known issue match"} |`);
  }
  if (valid && report.unclassifiedErrors > 0) rows.push(`| NEW / UNCLASSIFIED | ${report.unclassifiedErrors} collection, hook or unhandled errors | See the original log |`);
  for (const [id, step] of Object.entries(steps)) {
    if (!["failure", "cancelled"].includes(step.outcome)) continue;
    const covered = step.outcome === "failure" && valid && id === report.step && report.complete && report.failures.length > 0 && report.unclassifiedErrors === 0;
    if (!covered) rows.push(`| NEW / UNCLASSIFIED | Step ${escape(id)}: ${escape(step.outcome)} | No complete matching test report; see the original log |`);
  }
  return [`## Candidate result: ${escape(key)} ${escape(version)} (${escape(os)})`, "",
    "Known labels are evidence links, not accepted failures. Original step outcomes and the workflow conclusion are unchanged.", "",
    ...(rows.length ? ["| Classification | Failure | Tracking |", "| --- | --- | --- |", ...rows] : ["No candidate failure was reported by these steps."]), ""].join("\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [key, os] = process.argv.slice(2);
  const directory = process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run";
  let report;
  try { report = JSON.parse(readFileSync(path.join(directory, "candidate-tests.json"), "utf8")); }
  catch { /* A killed or unstarted test process has no usable report. Its step stays unclassified. */ }
  const summary = candidateSummary({ key, os, version: process.env.OAR_CI_CANDIDATE_VERSION,
    steps: JSON.parse(process.env.OAR_CANDIDATE_STEPS ?? "{}"), report });
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "candidate-summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}
