import { expect, test } from "vitest";
import {
  kimiAccountEmail,
  kimiAccountPlan,
  projectKimiUsage,
} from "../../packages/oar/src/runtimes/kimi/account-usage.js";

const managedUsageFixture = {
  usage: {
    used: "225",
    limit: "1000",
    resetTime: "2026-08-31T00:00:00Z",
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        used: "50",
        limit: "100",
        resetTime: "2026-08-27T10:00:00Z",
      },
    },
    {
      name: "Daily cap",
      detail: { used: 7, limit: 10 },
    },
  ],
  boosterWallet: {
    balance: {
      type: "BOOSTER",
      amount: "20000000000",
      amountLeft: "10000000000",
    },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { currency: "CNY", priceInCents: "20000" },
    monthlyUsed: { currency: "CNY", priceInCents: "5000" },
  },
};

test("kimi projection mirrors the managed quota rows rendered by /usage", () => {
  const snapshot = projectKimiUsage(managedUsageFixture, "person@example.com", "Vivace");
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "email": "person@example.com",
      "kind": "available",
      "plan": "Vivace",
      "rateLimited": false,
      "windows": [
        {
          "label": "Weekly limit",
          "resetsAt": "2026-08-31T00:00:00.000Z",
          "usedRatio": 0.225,
        },
        {
          "label": "5h limit",
          "resetsAt": "2026-08-27T10:00:00.000Z",
          "usedRatio": 0.5,
        },
        {
          "label": "Daily cap",
          "usedRatio": 0.7,
        },
        {
          "label": "Extra Usage monthly limit",
          "usedRatio": 0.25,
        },
      ],
    }
  `);
});

test("kimi account email requires an authenticated profile shape", () => {
  expect(kimiAccountEmail({ user_id: "user-1", email: " person@example.com " }))
    .toBe("person@example.com");
  expect(kimiAccountEmail({ email: "person@example.com" })).toBeUndefined();
  expect(kimiAccountEmail({ user_id: "user-1", email: "" })).toBeUndefined();
});

test("kimi account plan requires the authenticated profile's named membership level", () => {
  expect(kimiAccountPlan({ user_id: "user-1", user_level_name: " Vivace " }))
    .toBe("Vivace");
  expect(kimiAccountPlan({ user_level_name: "Vivace" })).toBeUndefined();
  expect(kimiAccountPlan({ user_id: "user-1", user_level_name: "" })).toBeUndefined();
  expect(kimiAccountPlan({ user_id: "user-1", user_level: 4 })).toBeUndefined();
});

test("kimi projection clamps exhausted windows and skips unusable limits", () => {
  expect(projectKimiUsage({
    usage: { used: "101", limit: "100" },
    limits: [
      { detail: { used: 5, limit: 0 } },
      { detail: { used: -1, limit: 10 } },
      { detail: { limit: 20 }, window: { duration: 2, timeUnit: "TIME_UNIT_DAY" } },
    ],
  })).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "rateLimited": true,
      "windows": [
        {
          "label": "Weekly limit",
          "usedRatio": 1,
        },
        {
          "label": "2d limit",
          "usedRatio": 0,
        },
      ],
    }
  `);
});

test("kimi Extra Usage headroom bypasses exhausted subscription windows", () => {
  const payload = {
    usage: { used: "100", limit: "100" },
    boosterWallet: {
      balance: {
        type: "BOOSTER",
        amount: "20000000000",
        amountLeft: "10000000000",
      },
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimit: { currency: "CNY", priceInCents: "20000" },
      monthlyUsed: { currency: "CNY", priceInCents: "5000" },
    },
  };
  expect(projectKimiUsage(payload)).toMatchObject({
    kind: "available",
    rateLimited: false,
  });

  expect(projectKimiUsage({
    ...payload,
    boosterWallet: {
      ...payload.boosterWallet,
      monthlyUsed: { currency: "CNY", priceInCents: "20000" },
    },
  })).toMatchObject({
    kind: "available",
    rateLimited: true,
  });
});
