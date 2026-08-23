/**
 * Behavior-test entry, OpenDAL-style: the backend is selected by environment
 * and an absent backend SKIPS rather than fails.
 *
 *   pnpm sea-trial                        # mock fixture (what CI also runs)
 *   OAR_TEST=codex pnpm sea-trial         # the real, logged-in codex
 *   OAR_TEST=claude OAR_TEST_MODEL=haiku pnpm sea-trial
 *   OAR_TEST=claude-aimock pnpm sea-trial # real binary, scripted provider, zero tokens
 *   OAR_TEST=codex-aimock pnpm sea-trial
 */
import {
  claudeInstallation,
  claudeSession,
  codexInstallation,
  codexSession,
  defineRuntime,
  piInstallation,
  piSession,
  runtimes,
  type Runtime,
} from "../packages/oar/src/index.js";
import { accountUsageCases } from "./cases/account-usage.js";
import { installationCases } from "./cases/installation.js";
import { sessionCases } from "./cases/session.js";
import { startMockSession } from "./fixtures/mock-session.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "./harness/aimock.js";
import { runSuite } from "./harness/runner.js";
import { openTrace } from "./harness/trace.js";
import { runtimeUnderTest } from "./harness/subject.js";

const target = process.env.OAR_TEST ?? "mock";
let aimockEnv: AimockEnv | null = null;
// oxlint-disable-next-line init-declarations -- assigned exactly once by the backend selector below
let runtime: Runtime;
if (target === "mock") {
  runtime = defineRuntime({
    id: "mock",
    session: startMockSession,
    installation: async () => {
      await Promise.resolve();
      return { kind: "available" as const, via: "bundled" as const };
    },
  });
} else if (target === "claude-aimock") {
  // Real binary + real adapter; only the model provider is scripted. Account
  // usage stays off this composition — it would query the real service.
  aimockEnv = await startClaudeAimock();
  runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
} else if (target === "codex-aimock") {
  aimockEnv = await startCodexAimock();
  runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
} else if (target === "pi-aimock") {
  aimockEnv = await startPiAimock();
  runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
} else {
  runtime = runtimes.require(target);
}

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
