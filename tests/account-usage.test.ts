import { expect, test } from "vitest";
import {
  claudeAccountPlan,
  projectClaudeUsage,
} from "../packages/oar/src/runtimes/claude/account-usage.js";
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
          "label": "Codex · 1 week",
          "resetsAt": "2027-01-17T15:33:20.000Z",
          "usedRatio": 0.92,
        },
        {
          "label": "GPT-5.3-Codex-Spark · 5 hours",
          "resetsAt": "2027-01-15T08:00:00.000Z",
          "usedRatio": 0,
        },
        {
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
          "label": "1 week",
          "resetsAt": "2027-01-15T08:00:00.000Z",
          "usedRatio": 0.5,
        },
        {
          "label": "GPT-5.3-Codex-Spark · 5 hours",
          "resetsAt": "2027-01-16T11:46:40.000Z",
          "usedRatio": 0,
        },
      ],
    }
  `);
});

test("claude projection maps the usage endpoint's limits array", () => {
  const snapshot = projectClaudeUsage({
    limits: [
      { kind: "session", percent: 7, severity: "normal", resets_at: "2026-08-22T09:59:00.000Z", scope: null },
      { kind: "weekly_all", percent: 14, severity: "normal", resets_at: "2026-08-28T06:59:00.000Z", scope: null },
      { kind: "weekly_scoped", percent: 100, severity: "critical", resets_at: null,
        scope: { model: { display_name: "Fable" } } },
    ],
  });
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "rateLimited": true,
      "windows": [
        {
          "label": "Current session",
          "resetsAt": "2026-08-22T09:59:00.000Z",
          "usedRatio": 0.07,
        },
        {
          "label": "Current week (all models)",
          "resetsAt": "2026-08-28T06:59:00.000Z",
          "usedRatio": 0.14,
        },
        {
          "label": "Current week (Fable)",
          "usedRatio": 1,
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

test("claude projection includes the account identity when supplied", () => {
  const snapshot = projectClaudeUsage(
    { limits: [{ kind: "weekly_scoped", percent: 22, severity: "normal", resets_at: null,
      scope: { model: { display_name: "Fable" } } }] },
    "person@example.com",
    "max",
  );
  expect(snapshot).toMatchObject({
    kind: "available",
    email: "person@example.com",
    plan: "max",
  });
});

test("claude account plan accepts only an explicit confirmed-login tier", () => {
  expect(claudeAccountPlan({ loggedIn: true, subscriptionType: " max " })).toBe("max");
  expect(claudeAccountPlan({ loggedIn: false, subscriptionType: "max" })).toBeUndefined();
  expect(claudeAccountPlan({ loggedIn: true, subscriptionType: "" })).toBeUndefined();
  expect(claudeAccountPlan({ loggedIn: true, subscriptionType: 42 })).toBeUndefined();
});

test("claude projection throws when the endpoint reports no limits", () => {
  expect(() => projectClaudeUsage({ limits: [] })).toThrow(/no usable windows/u);
  expect(() => projectClaudeUsage({})).toThrow(/no usable windows/u);
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
  expect(projectGrokUsage({ config: null })).toEqual({ kind: "unsupported" });
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
