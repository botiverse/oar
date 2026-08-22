import { expect, test } from "vitest";
import { projectClaudeUsage } from "../packages/oar/src/runtimes/claude/account-usage.js";
import { projectCodexUsage } from "../packages/oar/src/runtimes/codex/account-usage.js";

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

test("claude projection accepts windows with and without reset text", () => {
  const snapshot = projectClaudeUsage(
    "Current session: 7% used · resets Aug 21 at 7:39pm (Asia/Shanghai)\n"
      + "Current week (Fable): 0% used",
  );
  expect(snapshot).toMatchInlineSnapshot(`
    {
      "kind": "available",
      "rateLimited": false,
      "windows": [
        {
          "label": "Current session",
          "usedRatio": 0.07,
        },
        {
          "label": "Current week (Fable)",
          "usedRatio": 0,
        },
      ],
    }
  `);
});
