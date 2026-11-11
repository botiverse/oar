import { expect, it } from "vitest";
import { statusAfterLogout } from "../../packages/oar/src/shared/logout.js";

it("the status read after a logout gets the rest of the caller's budget, at least one second, or its own default", () => {
  const now = Date.now();
  expect(statusAfterLogout(now, undefined)).toEqual({});
  const rest = statusAfterLogout(now - 10_000, 40_000).timeoutMs ?? 0;
  expect(rest).toBeGreaterThan(29_000);
  expect(rest).toBeLessThanOrEqual(30_000);
  expect(statusAfterLogout(now - 60_000, 40_000)).toEqual({ timeoutMs: 1000 });
});
