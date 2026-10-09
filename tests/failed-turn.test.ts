import { expect, test } from "vitest";
import { utcInstantFromDate, type FailedTurn, type UtcInstant } from "../packages/oar/src/index.js";

/*
 * A failed turn is tagged by `failure`: `credential` exists only on `auth`,
 * `resetsAt` only on `quota`, so a host reads either only after checking
 * `failure`. The `@ts-expect-error` lines are the test: the typecheck fails
 * if any of them compiles.
 */

function instant(iso: string): UtcInstant {
  const value = utcInstantFromDate(new Date(iso));
  if (value === null) { throw new Error(`not an instant: ${iso}`); }
  return value;
}
const resetsAt = instant("2026-10-09T15:00:00.000Z");
const failures: readonly FailedTurn[] = [
  { kind: "failed", reason: "Not logged in", failure: "auth", credential: "missing" },
  { kind: "failed", reason: "You've hit your session limit", failure: "quota", status: 429, resetsAt },
  { kind: "failed", reason: "Request rejected (429)", failure: "rate_limited", status: 429 },
];

/** What a host reads off a failure once it has checked `failure`. */
function detail(failed: FailedTurn): unknown {
  if (failed.failure === "auth") { return failed.credential; }
  if (failed.failure === "quota") { return failed.resetsAt; }
  return failed.status;
}

test("credential and resetsAt are read only after checking failure", () => {
  const unchecked = failures.map((failed) => {
    // @ts-expect-error `credential` is an auth failure's: check `failure` first.
    const credential: unknown = failed.credential;
    // @ts-expect-error `resetsAt` is a quota failure's: check `failure` first.
    const reset: unknown = failed.resetsAt;
    return [credential, reset];
  });
  expect(unchecked).toEqual([["missing", undefined], [undefined, "2026-10-09T15:00:00.000Z"], [undefined, undefined]]);
  expect(failures.map((failed) => detail(failed))).toEqual(["missing", "2026-10-09T15:00:00.000Z", 429]);
});

test("a failure carries no field another class means", () => {
  const built: FailedTurn[] = [
    // @ts-expect-error rate_limited never carries resetsAt: retry delays are not oar's.
    { kind: "failed", reason: "throttled", failure: "rate_limited", resetsAt },
    // @ts-expect-error only auth says which credential problem.
    { kind: "failed", reason: "limit", failure: "quota", credential: "rejected" },
    // @ts-expect-error only quota says when its limit resets.
    { kind: "failed", reason: "no login", failure: "auth", resetsAt },
  ];
  expect(built).toHaveLength(3);
});
