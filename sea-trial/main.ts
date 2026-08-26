/**
 * Behavior-test entry, OpenDAL-style: the backend is selected by environment
 * and an absent backend SKIPS rather than fails.
 *
 *   pnpm sea-trial                        # mock fixture (what CI also runs)
 *   OAR_TEST=codex pnpm sea-trial         # the real, logged-in codex
 *   OAR_TEST=claude OAR_TEST_MODEL=haiku pnpm sea-trial
 *   OAR_TEST=grok pnpm sea-trial          # real Grok Build ACP
 *   OAR_TEST=kimi pnpm sea-trial          # real Kimi Code ACP
 *   OAR_TEST=claude-aimock pnpm sea-trial # real binary, scripted provider, zero tokens
 *   OAR_TEST=codex-aimock pnpm sea-trial
 */
import { accountUsageCases } from "./cases/account-usage.js";
import { installationCases } from "./cases/installation.js";
import { sessionCases } from "./cases/session.js";
import { selectBackend } from "./harness/backends.js";
import { runSuite } from "./harness/runner.js";
import { openTrace } from "./harness/trace.js";
import { runtimeUnderTest } from "./harness/subject.js";

const target = process.env.OAR_TEST ?? "mock";
const { runtime, aimock: aimockEnv } = await selectBackend(target);

const installation = await runtime.installation?.();
if (installation === undefined || installation.kind !== "available") {
  process.stdout.write(`${target}: not available (${installation?.kind ?? "no probe"}) — skipping\n`);
  await aimockEnv?.stop();
  process.exit(0);
}

// Vendor error-edge tests live in sea-trial/vendor/*.vendor.test.ts (vitest,
// OAR_TEST-gated) — the behavior CI job runs them right after this suite.
const cases = [...installationCases, ...accountUsageCases, ...sessionCases];
const tracePath = openTrace(target);
const outcomes = await runSuite(cases, runtimeUnderTest(runtime, aimockEnv?.env));
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
process.stdout.write(`trace: ${tracePath}\n`);
await aimockEnv?.stop();
process.exit(failures === 0 ? 0 : 1);
