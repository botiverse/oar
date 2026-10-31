import { expect, test } from "vitest";
import { runBackends } from "../sea-trial/harness/parallel-backends.js";

// eslint-disable-next-line max-statements -- Observe the queue before and after releasing one worker.
test("native backend workers cap at four, reuse a freed slot, and retain a failed outcome", async () => {
  const started: string[] = [];
  const releases = new Map<string, PromiseWithResolvers<number>>();
  const running = runBackends(["a", "b", "c", "d", "e", "f"], async (target) => {
    started.push(target);
    const release = Promise.withResolvers<number>();
    releases.set(target, release);
    return release.promise;
  }, 16);
  expect(started).toEqual(["a", "b", "c", "d"]);
  releases.get("b")?.resolve(1);
  await expect.poll(() => started).toEqual(["a", "b", "c", "d", "e"]);
  releases.get("e")?.resolve(0);
  await expect.poll(() => started).toEqual(["a", "b", "c", "d", "e", "f"]);
  for (const name of ["a", "c", "d", "f"]) { releases.get(name)?.resolve(0); }
  expect(await running).toEqual([0, 1, 0, 0, 0, 0]);
});

test.each([1, 2])("a %i-core host runs one native backend at a time", async (cores) => {
  let active = 0; let maximum = 0;
  const results = await runBackends(["a", "b", "c"], async (target) => {
    active++; maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return target;
  }, cores);
  expect({ maximum, results }).toEqual({ maximum: 1, results: ["a", "b", "c"] });
});
