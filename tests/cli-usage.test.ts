import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { defineRuntime, utcInstantFromDate } from "../packages/oar/src/index.js";
import { readUsage, renderUsageReport, type UsageReport } from "../packages/cli/src/usage.js";

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

test("temporarily unavailable usage does not ask the user to sign in", () => {
  assert.deepEqual(renderUsageReport({ runtimeId: "kimi", accountUsage: { kind: "unavailable", reason: "access_token_expired" } }), ["kimi\tusage temporarily unavailable (access_token_expired); no sign-in required"]);
});

test("readUsage keeps allowPrintMode unset by default and forwards it when enabled", async () => {
  const accountUsage = vi.fn(async (_inst, opts?: { readonly allowPrintMode?: boolean }) =>
    opts?.allowPrintMode === true ? ({ kind: "available", rateLimited: false, windows: [] } as const) : ({ kind: "unsupported", reason: "print_mode_disabled" } as const));
  const fake = defineRuntime({
    id: "fake",
    session: async () => { throw new Error("unused"); },
    installation: async () => ({ kind: "available", via: "executable", command: "fake" }),
    accountUsage,
  });
  const skipped = await readUsage(fake);
  assert.deepEqual(skipped, { runtimeId: "fake", accountUsage: { kind: "unsupported", reason: "print_mode_disabled" } });
  assert.equal(accountUsage.mock.calls[0]?.[1], undefined);
  assert.deepEqual(renderUsageReport(skipped), ["fake\tno usage (print_mode_disabled; pass --allow-print-mode to allow CLI print mode)"]);
  const allowed = await readUsage(fake, { allowPrintMode: true });
  assert.deepEqual(allowed, { runtimeId: "fake", accountUsage: { kind: "available", rateLimited: false, windows: [] } });
  assert.deepEqual(accountUsage.mock.calls[1]?.[1], { allowPrintMode: true });
});
