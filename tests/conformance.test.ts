import assert from "node:assert/strict";
import test from "node:test";
import { accountUsageCases } from "../sea-trial/cases/account-usage.js";
import { installationCases } from "../sea-trial/cases/installation.js";
import { sessionCases } from "../sea-trial/cases/session.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import { runSuite } from "../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";
import { defineRuntime } from "../packages/oar/src/index.js";

const fixture = defineRuntime({
  id: "fixture",
  session: startMockSession,
  installation: async () => ({ kind: "available" as const, via: "bundled" as const }),
  accountUsage: async () => ({
    kind: "available" as const,
    rateLimited: false,
    windows: [],
  }),
});

test("the mock fixture passes every shared sea-trial case", async () => {
  const cases = [...installationCases, ...accountUsageCases, ...sessionCases];
  const outcomes = await runSuite(cases, runtimeUnderTest(fixture));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind),
    cases.map(() => "pass"),
    JSON.stringify(outcomes),
  );
});
