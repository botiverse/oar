/**
 * Behavior-test entry, OpenDAL-style: the backend is selected by environment
 * and an absent backend SKIPS rather than fails.
 *
 *   pnpm sea-trial                 # mock fixture (what CI also runs)
 *   OAR_TEST=codex pnpm sea-trial  # the real, logged-in codex
 *   OAR_TEST=claude OAR_TEST_MODEL=haiku pnpm sea-trial
 */
import { defineRuntime, runtimes, type Runtime } from "../packages/oar/src/index.js";
import { accountUsageCases } from "./cases/account-usage.js";
import { installationCases } from "./cases/installation.js";
import { sessionCases } from "./cases/session.js";
import { startMockSession } from "./fixtures/mock-session.js";
import { runSuite } from "./harness/runner.js";
import { runtimeUnderTest } from "./harness/subject.js";

const target = process.env.OAR_TEST ?? "mock";
const runtime: Runtime = target === "mock"
  ? defineRuntime({
      id: "mock",
      session: startMockSession,
      installation: async () => {
        await Promise.resolve();
        return { kind: "available" as const, via: "bundled" as const };
      },
    })
  : runtimes.require(target);

const installation = await runtime.installation?.();
if (installation === undefined || installation.kind !== "available") {
  process.stdout.write(`${target}: not available (${installation?.kind ?? "no probe"}) — skipping\n`);
  process.exit(0);
}

const cases = [...installationCases, ...accountUsageCases, ...sessionCases];
const outcomes = await runSuite(cases, runtimeUnderTest(runtime));
let failures = 0;
for (const outcome of outcomes) {
  if (outcome.kind === "fail") {
    failures += 1;
    process.stdout.write(`FAIL ${outcome.caseId}: ${outcome.reason}\n`);
  } else {
    process.stdout.write(`${outcome.kind.toUpperCase().padEnd(7)} ${outcome.caseId}\n`);
  }
}
process.stdout.write(`${target}: ${outcomes.length - failures}/${outcomes.length} clean\n`);
process.exit(failures === 0 ? 0 : 1);
