import assert from "node:assert/strict";
import { test } from "vitest";
import { utcInstantFromDate } from "../packages/oar/src/index.js";
import { renderUsageReport, type UsageReport } from "../packages/cli/src/usage.js";

type Snapshot = NonNullable<UsageReport["accountUsage"]>;
const at = utcInstantFromDate(new Date("2026-11-22T07:00:00.000Z"));
assert.ok(at !== null);

test("an available account shows who, plan, each window's use and reset, and reset count", () => {
  const usage: Snapshot = {
    kind: "available", email: "a@example.test", plan: "max", rateLimited: true,
    windows: [
      { label: "Current week (all models)", usedRatio: 0.031, resetsAt: at, scope: { kind: "account" } },
      { label: "Current week (Fable)", usedRatio: 0.02, scope: { kind: "model", name: "Fable" } },
      { label: "Weekly", usedRatio: 1, scope: { kind: "models", name: "Gemini Models" } },
    ],
    limitResets: { available: 2 },
  };
  assert.deepEqual(renderUsageReport({ runtimeId: "fake", accountUsage: usage }), [
    "fake\ta@example.test, max, rate limited now",
    "  Current week (all models): 3% used, resets 2026-11-22T07:00:00.000Z",
    "  Current week (Fable): 2% used",
    "  Weekly (Gemini Models): 100% used",
    "  limit resets available: 2",
  ]);
});

test("reauth, unsupported, missing installation and a failed read each get one line", () => {
  assert.deepEqual(renderUsageReport({ runtimeId: "a", accountUsage: { kind: "reauth_required", reason: "not_authenticated" } }), ["a\tsign in again (not_authenticated)"]);
  assert.deepEqual(renderUsageReport({ runtimeId: "b", accountUsage: { kind: "unsupported", reason: "capability_unavailable" } }), ["b\tno usage (capability_unavailable)"]);
  assert.deepEqual(renderUsageReport({ runtimeId: "c", installation: { kind: "not_found" } }), ["c\tnot available (not_found)"]);
  assert.deepEqual(renderUsageReport({ runtimeId: "d", error: "timeout" }), ["d\terror: timeout"]);
  assert.deepEqual(renderUsageReport({ runtimeId: "e", accountUsage: { kind: "available", rateLimited: false, windows: [] } }), ["e\tsigned in"]);
});
