import { expect, test } from "vitest";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { runSuite } from "../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";

function controlledCases() {
  const releases = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const runtime = scriptedRuntime({ turn: () => {} });
  const run = runSuite(releases.map((release, index) => ({
    id: String(index), requires: [], run: async () => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
      if (index === 1) { throw new Error("retained failure"); }
    },
  })), runtimeUnderTest(runtime), 2);
  return { releases, started, run, peak: () => peak };
}

test("bounded behavior workers preserve every outcome, including a failure", async () => {
  const { releases, started, run, peak } = controlledCases();
  await expect.poll(() => started.length).toBe(2);
  expect(started).toEqual([0, 1]);
  for (const index of [1, 2]) {
    releases[index]?.resolve();
    // eslint-disable-next-line no-await-in-loop -- Release the next worker only after its predecessor has started.
    await expect.poll(() => started.length).toBe(index + 2);
  }
  releases[3]?.resolve();
  releases[0]?.resolve();
  expect(await run).toEqual([
    { kind: "pass", caseId: "0" },
    { kind: "fail", caseId: "1", reason: "retained failure" },
    { kind: "pass", caseId: "2" },
    { kind: "pass", caseId: "3" },
  ]);
  expect(peak()).toBe(2);
});
