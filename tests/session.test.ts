import assert from "node:assert/strict";
import test from "node:test";
import { startMockSession } from "../drydock/mock-session.js";
import { runtimeUnderTest } from "../drydock/runner.js";
import { runSuite } from "../sea-trial/runner.js";
import { sessionCases } from "../sea-trial/cases/session.js";
import { defineRuntime } from "../packages/oar/src/index.js";

const mockRuntime = defineRuntime({
  id: "mock",
  installation: async () => ({ kind: "available" as const, via: "bundled" as const }),
  session: startMockSession,
});

test("mock runtime passes every shared session behavior case", async () => {
  const outcomes = await runSuite(sessionCases, runtimeUnderTest(mockRuntime));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind),
    sessionCases.map(() => "pass"),
    JSON.stringify(outcomes),
  );
});
