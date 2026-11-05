import { expect, test } from "vitest";
import { projectKimiUsage } from "../../packages/oar/src/runtimes/kimi/account-usage.js";

const exhausted = { used: "100", limit: "100" };
const wallet = {
  balance: { type: "BOOSTER", amount: "200", amountLeft: "100" },
  monthlyChargeLimitEnabled: true,
  monthlyChargeLimit: { priceInCents: "200" },
  monthlyUsed: { priceInCents: "50" },
};

test.each([undefined, null, [], "broken", {}, { usage: {} }])("Kimi refuses a quota response with no usable windows (%#)", (payload) => {
  expect(() => projectKimiUsage(payload)).toThrow(/Kimi usage response/u);
});

test.each([null, "broken", "", " ", false, {}, [], -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY])("a damaged present metric is not zero usage (%#)", (used) => {
  expect(() => projectKimiUsage({ usage: { used, limit: "100" } })).toThrow(/no usable quota windows/u);
  expect(projectKimiUsage({ usage: exhausted, limits: [{ detail: { used, limit: "100" } }] })).toEqual({
    kind: "available", rateLimited: true, windows: [{ label: "Weekly limit", usedRatio: 1 }],
  });
});

test("a valid secondary window survives a damaged primary window", () => {
  expect(projectKimiUsage({ usage: { used: "broken", limit: "100" }, limits: [{ name: "Daily cap", detail: { used: 3, limit: 10 } }] })).toEqual({
    kind: "available", rateLimited: false, windows: [{ label: "Daily cap", usedRatio: 0.3 }],
  });
});

test.each([0, "0", undefined])("valid zero and native omitted usage remain readable (%#)", (used) => {
  expect(projectKimiUsage({ usage: { used, limit: "100" } })).toEqual({
    kind: "available", rateLimited: false, windows: [{ label: "Weekly limit", usedRatio: 0 }],
  });
});

test.each([
  { ...wallet, monthlyChargeLimitEnabled: "broken" },
  { ...wallet, monthlyUsed: { priceInCents: "broken" } },
  { ...wallet, monthlyChargeLimit: { priceInCents: "broken" } },
  { ...wallet, balance: { ...wallet.balance, amountLeft: "broken" } },
  { ...wallet, balance: { ...wallet.balance, amountLeft: null } },
])("damaged Extra Usage does not invent headroom or a numeric window (%#)", (boosterWallet) => {
  expect(projectKimiUsage({ usage: exhausted, boosterWallet })).toEqual({
    kind: "available", rateLimited: true, windows: [{ label: "Weekly limit", usedRatio: 1 }],
  });
});
