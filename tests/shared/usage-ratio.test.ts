import { expect, test } from "vitest";
import { usedRatioFromCounts, usedRatioFromPercent, usedRatioFromRemaining, usedRatioOf } from "../../packages/oar/src/shared/usage-ratio.js";

test("usedRatioOf and usedRatioFromPercent reach 1 only when natively exhausted", () => {
  expect(usedRatioOf(0)).toBe(0);
  expect(usedRatioOf(-0.2)).toBe(0);
  expect(usedRatioOf(0.9999999)).toBe(0.999999);
  expect(usedRatioOf(1)).toBe(1);
  expect(usedRatioOf(1.5)).toBe(1);
  expect(usedRatioFromPercent(0)).toBe(0);
  expect(usedRatioFromPercent(99.99999)).toBe(0.999999);
  expect(usedRatioFromPercent(100)).toBe(1);
  expect(usedRatioFromPercent(105)).toBe(1);
});

test("usedRatioFromCounts and usedRatioFromRemaining reach 1 only when natively exhausted", () => {
  expect(usedRatioFromCounts(0, 100)).toBe(0);
  expect(usedRatioFromCounts(9_999_999, 10_000_000)).toBe(0.999999);
  expect(usedRatioFromCounts(100, 100)).toBe(1);
  expect(usedRatioFromCounts(120, 100)).toBe(1);
  expect(usedRatioFromRemaining(1)).toBe(0);
  expect(usedRatioFromRemaining(1e-7)).toBe(0.999999);
  expect(usedRatioFromRemaining(0)).toBe(1);
  expect(usedRatioFromRemaining(-0.1)).toBe(1);
});

test("non-finite inputs map consistently to 0 across all ratio helpers", () => {
  expect(usedRatioOf(Number.NaN)).toBe(0);
  expect(usedRatioFromPercent(Number.NaN)).toBe(0);
  expect(usedRatioFromCounts(Number.NaN, 100)).toBe(0);
  expect(usedRatioFromRemaining(Number.NaN)).toBe(0);
});
