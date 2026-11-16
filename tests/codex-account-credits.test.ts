import { expect, test } from "vitest";
import { projectCodexUsage } from "../packages/oar/src/runtimes/codex/account-usage.js";

test.each([
  { name: "available credits", credits: { hasCredits: true, unlimited: false, balance: "1.25" }, limited: false },
  { name: "unlimited credits", credits: { hasCredits: false, unlimited: true }, limited: false },
  { name: "no credits", credits: { hasCredits: false, unlimited: false, balance: "0" }, limited: true },
  { name: "missing credits", credits: undefined, limited: true },
  { name: "null credits", credits: null, limited: true },
  { name: "unknown credits shape", credits: "available", limited: true },
  { name: "unknown credits fields", credits: { futureBalance: 10 }, limited: true },
  { name: "non-boolean flags", credits: { hasCredits: "true", unlimited: 1 }, limited: true },
  { name: "balance alone", credits: { balance: "10" }, limited: true },
])("codex weighs $name against the native reached flag", ({ credits, limited }) => {
  const snapshot = projectCodexUsage({ rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 10_080 },
    rateLimitReachedType: "rate_limit_reached",
    credits,
  } });
  expect(snapshot).toMatchObject({ rateLimited: limited, windows: [{ usedRatio: 1, id: "codex:primary" }] });
});

test.each([null, undefined])("codex does not infer a refusal from full windows with flag %s", (rateLimitReachedType) => {
  const snapshot = projectCodexUsage({ rateLimits: {
    primary: { usedPercent: 100, windowDurationMins: 300 },
    secondary: { usedPercent: 100, windowDurationMins: 10_080 },
    rateLimitReachedType,
    credits: { hasCredits: false, unlimited: false },
  } });
  expect(snapshot).toMatchObject({ rateLimited: false, windows: [{ usedRatio: 1 }, { usedRatio: 1 }] });
});

test("codex keeps the native refusal even before a window reports 100 percent", () => {
  expect(projectCodexUsage({ rateLimits: {
    primary: { usedPercent: 99, windowDurationMins: 300 },
    rateLimitReachedType: "rate_limit_reached",
    credits: { hasCredits: false, unlimited: false },
  } })).toMatchObject({ rateLimited: true });
});

test("codex credits only clear the reached flag on their own bucket", () => {
  const rateLimits = {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 10_080 },
    rateLimitReachedType: "rate_limit_reached",
    credits: { hasCredits: true, unlimited: false },
  };
  const other = {
    limitId: "other_model", limitName: "Other model",
    primary: { usedPercent: 100, windowDurationMins: 300 },
    rateLimitReachedType: "rate_limit_reached",
    credits: { hasCredits: false, unlimited: false },
  };
  expect(projectCodexUsage({ rateLimits, rateLimitsByLimitId: { other } })).toMatchObject({ rateLimited: true });
  expect(projectCodexUsage({ rateLimits, rateLimitsByLimitId: {
    other: { ...other, credits: { hasCredits: true, unlimited: false } },
  } })).toMatchObject({ rateLimited: false });
});

test("codex reports the default bucket's credit balance without parsing or adding model balances", () => {
  const snapshot = projectCodexUsage({ rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 100 }, credits: { hasCredits: true, unlimited: false, balance: "0012.340000" } },
    model: { limitId: "model", limitName: "Other model", primary: { usedPercent: 100 }, credits: { hasCredits: true, balance: "99" } },
  } });
  expect(snapshot).toMatchObject({ credits: { available: true, unlimited: false, balance: "0012.340000" } });
});

test.each([
  { native: { hasCredits: false, unlimited: false, balance: "0" }, projected: { available: false, unlimited: false, balance: "0" } },
  { native: { unlimited: true }, projected: { available: true, unlimited: true } },
  { native: { hasCredits: true, balance: 123 }, projected: { available: true } },
])("codex preserves reported credit availability: $native", ({ native, projected }) => {
  expect(projectCodexUsage({ rateLimits: {
    primary: { usedPercent: 100 }, credits: native,
  } })).toMatchObject({ credits: projected });
});

test.each([undefined, null, {}, "unknown", { balance: "10" }, { hasCredits: "true" }])("codex omits unavailable credit information: %j", (credits) => {
  expect(projectCodexUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 100 }, credits } }))
    .not.toHaveProperty("credits");
});

test("codex does not promote model-only credits to the account", () => {
  expect(projectCodexUsage({ rateLimits: {
    limitId: "model", limitName: "Other model", primary: { usedPercent: 100 }, credits: { hasCredits: true, balance: "10" },
  } })).not.toHaveProperty("credits");
});

test("codex accepts credits on an unnamed legacy bucket with null identifiers", () => {
  expect(projectCodexUsage({ rateLimits: {
    limitId: null, limitName: null, primary: { usedPercent: 100 },
    credits: { hasCredits: true, balance: "12" },
  } })).toMatchObject({ credits: { available: true, balance: "12" } });
});
