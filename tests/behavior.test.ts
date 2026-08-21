import assert from "node:assert/strict";
import test from "node:test";
import { runtimeUnderTest } from "../drydock/runner.js";
import { accountUsageCases } from "../sea-trial/cases/account-usage.js";
import { installationCases } from "../sea-trial/cases/installation.js";
import { runSuite } from "../sea-trial/runner.js";
import { defineRuntime } from "../packages/oar/src/index.js";

const fixture = defineRuntime({
  id: "fixture",
  installation: {
    async probe() {
      return {
        kind: "available" as const,
        version: "1.0.0",
      };
    },
  },
  accountUsage: {
    async read() {
      return {
        kind: "available" as const,
        rateLimited: false,
        windows: [],
      };
    },
  },
});

test("drydock executes shared sea-trial behavior cases", async () => {
  const outcomes = await runSuite(
    [...installationCases, ...accountUsageCases],
    runtimeUnderTest(fixture),
  );
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["pass", "pass"]);
});
