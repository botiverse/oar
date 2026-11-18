import { expect, test } from "vitest";
import { projectKimiNativeUsage } from "../../packages/oar/src/runtimes/kimi/native-usage.js";

const usages = { limit5h: { usedRatio: 1.2, resetAt: "2030-01-01T00:00:00Z" }, limit7d: { usedRatio: 0.5 }, monthTotal: { usedRatio: -0.1 }, monthCode: { usedRatio: 0.2 } };
test("native managed quota ratios, resets and monthly buckets are preserved", () => {
  expect(projectKimiNativeUsage({ usages })).toEqual({ kind: "available", rateLimited: true, windows: [
    { label: "5h limit", usedRatio: 1, resetsAt: "2030-01-01T00:00:00.000Z", scope: { kind: "account" } },
    { label: "Weekly limit", usedRatio: 0.5, scope: { kind: "account" } }, { label: "Monthly limit", usedRatio: 0, scope: { kind: "account" } }, { label: "Monthly code limit", usedRatio: 0.2, scope: { kind: "account" } },
  ] });
});
test.each([
  [{ balanceCents: 10, monthlyChargeLimitEnabled: false }, false],
  [{ balanceCents: 10, monthlyChargeLimitEnabled: true, monthlyChargeLimitCents: 20, monthlyUsedCents: 5 }, false],
  [{ balanceCents: 10, monthlyChargeLimitEnabled: true, monthlyChargeLimitCents: 20, monthlyUsedCents: 20 }, true],
  [{ balanceCents: 0, monthlyChargeLimitEnabled: false }, true],
  [{ balanceCents: 10 }, true], [{ balanceCents: Infinity, monthlyChargeLimitEnabled: false }, true],
])("native Extra Usage headroom controls refusal: %j", (extraUsage, rateLimited) => {
  expect(projectKimiNativeUsage({ usages, extraUsage })).toMatchObject({ rateLimited });
});
test.each([{}, { usages: {} }, { usages: {}, extraUsage: null }])("native no-data quota is unsupported, not zero usage (%#)", quota => {
  expect(projectKimiNativeUsage(quota)).toEqual({ kind: "unsupported", reason: "quota_unavailable" });
});
test.each([null, [], "broken", { limit7d: { usedRatio: "broken" } }, { unknown: {} }])("present malformed native quota still rejects (%#)", value => {
  expect(() => projectKimiNativeUsage({ usages: value })).toThrow("no usable quota windows");
});

test("an exhausted extra spending cap does not exhaust the subscription", () => {
  const result = projectKimiNativeUsage({ usages: { limit7d: { usedRatio: 0.5 } }, extraUsage: { balanceCents: 10, monthlyChargeLimitEnabled: true, monthlyChargeLimitCents: 20, monthlyUsedCents: 20 } });
  expect(result).toMatchObject({ rateLimited: false, windows: [{ usedRatio: 0.5 }, { usedRatio: 1 }] });
});
test("invalid spending values produce neither a window nor extra headroom", () => {
  expect(projectKimiNativeUsage({ usages: { limit7d: { usedRatio: 1 } }, extraUsage: { balanceCents: 10, monthlyChargeLimitEnabled: true, monthlyChargeLimitCents: Infinity, monthlyUsedCents: NaN } })).toMatchObject({ rateLimited: true, windows: [{ usedRatio: 1 }] });
});
