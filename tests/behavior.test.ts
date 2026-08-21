import assert from "node:assert/strict";
import test from "node:test";
import { runtimeUnderTest } from "../drydock/runner.js";
import { accountUsageCases } from "../sea-trial/cases/account-usage.js";
import { installationCases } from "../sea-trial/cases/installation.js";
import { runSuite } from "../sea-trial/runner.js";
import {
  ACCOUNT_USAGE_PROTOCOL_VERSION,
  defineRuntime,
} from "../packages/oar/src/index.js";

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
        protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
        runtime: "fixture",
        collectedAt: new Date(0).toISOString(),
        staleAfter: new Date(60_000).toISOString(),
        acquisition: "structured_endpoint" as const,
        scope: "account_global" as const,
        collectorVersion: "fixture",
        accounts: [{
          accountKey: "0".repeat(64),
          health: "ok" as const,
          windows: [],
        }],
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
