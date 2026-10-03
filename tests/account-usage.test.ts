import { expect, test } from "vitest";
import { accountEmail, projectCodexUsage } from "../packages/oar/src/runtimes/codex/account-usage.js";
import {
  grokAccountEmail,
  projectGrokUsage,
} from "../packages/oar/src/runtimes/grok/account-usage.js";

const separateLimits = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    planType: "pro",
    primary: { usedPercent: 92, resetsAt: 1_800_200_000, windowDurationMins: 10_080 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      planType: "pro",
      primary: { usedPercent: 0, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 0, resetsAt: 1_800_100_000, windowDurationMins: 10_080 },
    },
    codex: {
      limitId: "codex",
      limitName: null,
      planType: "pro",
      primary: { usedPercent: 99, resetsAt: 1_800_200_000, windowDurationMins: 10_080 },
      secondary: null,
    },
  },
};

test("codex projection preserves typed rate-limit windows", () => {
  const snapshot = projectCodexUsage({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 25, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    },
  });
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "plan": "plus",
      "rateLimited": false,
      "windows": [
        {
          "durationMs": 18000000,
          "label": "5 hours",
          "resetsAt": "2027-01-15T08:00:00.000Z",
          "usedRatio": 0.25,
        },
      ],
    }
  `);
});

test("codex projection distinguishes windows from separate limits", () => {
  const snapshot = projectCodexUsage(separateLimits);
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "plan": "pro",
      "rateLimited": false,
      "windows": [
        {
          "durationMs": 604800000,
          "id": "codex:primary",
          "label": "Codex · 1 week",
          "resetsAt": "2027-01-17T15:33:20.000Z",
          "usedRatio": 0.92,
        },
        {
          "durationMs": 18000000,
          "id": "codex_bengalfox:primary",
          "label": "GPT-5.3-Codex-Spark · 5 hours",
          "resetsAt": "2027-01-15T08:00:00.000Z",
          "usedRatio": 0,
        },
        {
          "durationMs": 604800000,
          "id": "codex_bengalfox:secondary",
          "label": "GPT-5.3-Codex-Spark · 1 week",
          "resetsAt": "2027-01-16T11:46:40.000Z",
          "usedRatio": 0,
        },
      ],
    }
  `);
});

test("codex projection merges an extra-only indexed view", () => {
  const snapshot = projectCodexUsage({
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 50, resetsAt: 1_800_000_000, windowDurationMins: 10_080 },
      secondary: null,
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitName: "GPT-5.3-Codex-Spark",
        planType: "pro",
        primary: { usedPercent: 0, resetsAt: 1_800_100_000, windowDurationMins: 300 },
        secondary: null,
      },
    },
  });
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "plan": "pro",
      "rateLimited": false,
      "windows": [
        {
          "durationMs": 604800000,
          "label": "1 week",
          "resetsAt": "2027-01-15T08:00:00.000Z",
          "usedRatio": 0.5,
        },
        {
          "durationMs": 18000000,
          "label": "GPT-5.3-Codex-Spark · 5 hours",
          "resetsAt": "2027-01-16T11:46:40.000Z",
          "usedRatio": 0,
        },
      ],
    }
  `);
});

test("codex projection includes the account email when supplied", () => {
  const snapshot = projectCodexUsage(
    { rateLimits: { planType: "pro", primary: { usedPercent: 10, windowDurationMins: 300 } } },
    "person@example.com",
  );
  expect(snapshot).toMatchObject({ kind: "available", plan: "pro", email: "person@example.com" });
});

test("codex accountEmail accepts only a chatgpt account", () => {
  expect(accountEmail({ account: { type: "chatgpt", email: "person@example.com" } }))
    .toBe("person@example.com");
  expect(accountEmail({ account: { type: "apiKey", email: "person@example.com" } }))
    .toBeUndefined();
  expect(accountEmail({ account: { type: "chatgpt", email: 42 } })).toBeUndefined();
  expect(accountEmail({})).toBeUndefined();
});

test("grok projection preserves the vendor billing window and authenticated email", () => {
  const snapshot = projectGrokUsage({
    config: {
      creditUsagePercent: 22.5,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-24T00:00:00Z",
        end: "2026-08-31T00:00:00Z",
      },
      prepaidBalance: { val: 500 },
      isUnifiedBillingUser: true,
    },
    onDemandEnabled: true,
    subscription_tier: "SuperGrok",
  }, "person@example.com");
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "email": "person@example.com",
      "kind": "available",
      "plan": "SuperGrok",
      "rateLimited": false,
      "windows": [
        {
          "label": "Weekly included usage",
          "resetsAt": "2026-08-31T00:00:00.000Z",
          "usedRatio": 0.225,
        },
      ],
    }
  `);
});

test("grok account email accepts only a non-empty auth-info field", () => {
  expect(grokAccountEmail({ email: " person@example.com " })).toBe("person@example.com");
  expect(grokAccountEmail({ email: "" })).toBeUndefined();
  expect(grokAccountEmail({ email: 42 })).toBeUndefined();
});

test("grok projection falls back to legacy used/limit cents", () => {
  expect(projectGrokUsage({
    config: {
      used: { val: 250 },
      monthlyLimit: { val: 1000 },
      billingPeriodEnd: "2026-09-01T00:00:00Z",
    },
  })).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "rateLimited": false,
      "windows": [
        {
          "label": "Included usage",
          "resetsAt": "2026-09-01T00:00:00.000Z",
          "usedRatio": 0.25,
        },
      ],
    }
  `);
  expect(projectGrokUsage({ config: null })).toEqual({ kind: "unsupported", reason: "quota_unavailable" });
});

test("grok projection defaults omitted metrics to zero but rejects malformed usage", () => {
  const unused = {
    kind: "available", rateLimited: false,
    windows: [{ label: "Included usage", usedRatio: 0 }],
  };
  expect(projectGrokUsage({ config: {} })).toEqual(unused);
  expect(projectGrokUsage({
    config: { creditUsagePercent: null, used: null, monthlyLimit: null },
  })).toEqual(unused);
  expect(projectGrokUsage({ config: { creditUsagePercent: 0 } })).toMatchObject({
    kind: "available", windows: [{ usedRatio: 0 }], rateLimited: false,
  });
  for (const config of [
    { creditUsagePercent: "invalid" },
    { creditUsagePercent: -1 },
    { used: { val: 100 }, monthlyLimit: { val: 0 } },
  ]) {
    expect(() => projectGrokUsage({ config })).toThrow("no usable account usage percentage");
  }
});

test("grok projection keeps paid headroom distinct from included usage", () => {
  expect(projectGrokUsage({
    config: {
      creditUsagePercent: 100,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_MONTHLY",
        end: "2026-09-01T00:00:00Z",
      },
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 1250 },
    },
  })).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "rateLimited": false,
      "windows": [
        {
          "label": "Monthly included usage",
          "resetsAt": "2026-09-01T00:00:00.000Z",
          "usedRatio": 1,
        },
        {
          "label": "Pay-as-you-go",
          "resetsAt": "2026-09-01T00:00:00.000Z",
          "usedRatio": 0.25,
        },
      ],
    }
  `);
  expect(projectGrokUsage({
    config: { creditUsagePercent: 100, prepaidBalance: { val: -500 } },
  })).toMatchObject({ kind: "available", rateLimited: false });
  expect(projectGrokUsage({
    config: { creditUsagePercent: 100, onDemandCap: { val: 1000 }, onDemandUsed: { val: 1000 } },
  })).toMatchObject({ kind: "available", rateLimited: true });
});
