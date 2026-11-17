import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { knownCandidateFailure } from "./runtime-candidate-failures.mjs";

// Additional to Vitest's default reporter. No exception messages, assertion
// values or credentials are written here; the normal test output is unchanged.
export default class CandidateReporter {
  directory = process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run";
  report = { schemaVersion: 1, key: process.env.OAR_TEST, version: process.env.OAR_CI_CANDIDATE_VERSION,
    step: process.env.OAR_CANDIDATE_TEST_STEP, complete: false, failures: [], unclassifiedErrors: 0 };

  save() {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(path.join(this.directory, "candidate-tests.json"), `${JSON.stringify(this.report, null, 2)}\n`);
  }
  onTestRunStart() { this.save(); }
  onTestCaseResult(test) {
    const result = test.result();
    if (result.state !== "failed") return;
    const file = test.module.relativeModuleId.replaceAll("\\", "/");
    const name = test.fullName;
    const known = knownCandidateFailure({ ...this.report, file, name, errors: result.errors });
    this.report.failures.push({ file, name, ...(known ? { known } : {}) });
    this.save();
  }
  onTestRunEnd(modules, errors, reason) {
    this.report.unclassifiedErrors = errors.length + modules.reduce((total, module) =>
      total + module.errors().length + [...module.children.allSuites()].reduce((count, suite) => count + suite.errors().length, 0), 0);
    this.report.complete = reason !== "interrupted";
    this.save();
  }
}
