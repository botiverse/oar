import assert from "node:assert/strict";
import test from "node:test";
import { projectCodexRateLimitsReadSnapshot } from "./codexAccount.js";

test("projectCodexRateLimitsReadSnapshot maps primary/secondary windows", () => {
  const snap = projectCodexRateLimitsReadSnapshot({
    outcome: {
      kind: "ok",
      result: {
        rateLimits: {
          planType: "plus",
          primary: {
            usedPercent: 25,
            resetsAt: 1_785_819_600,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 100,
            resetsAt: 1_786_424_400,
            windowDurationMins: 10_080,
          },
        },
      },
    },
    collectorVersion: "test",
    observedAtMs: 1_700_000_000_000,
  });
  assert.equal(snap.provider, "codex");
  assert.equal(snap.protocolVersion, 1);
  assert.equal(snap.accounts.length, 1);
  const acc = snap.accounts[0]!;
  assert.equal(acc.planLabel, "plus");
  assert.equal(acc.health, "rate_limited");
  assert.equal(acc.windows.length, 2);
  assert.equal(acc.windows[0]!.status, "ok");
  assert.equal(acc.windows[0]!.usedRatio, 0.25);
  assert.equal(acc.windows[0]!.label, "5 hours");
  assert.equal(acc.windows[1]!.status, "limit_reached");
  assert.equal(acc.windows[1]!.usedRatio, 1);
  assert.equal(acc.windows[1]!.label, "7 days");
  assert.ok(acc.windows[0]!.resetsAt?.endsWith("Z"));
});

test("reauth_required has empty windows and health", () => {
  const snap = projectCodexRateLimitsReadSnapshot({
    outcome: { kind: "reauth_required" },
    collectorVersion: "test",
    observedAtMs: 1_700_000_000_000,
  });
  assert.equal(snap.accounts[0]!.health, "reauth_required");
  assert.equal(snap.accounts[0]!.windows.length, 0);
});

test("incomplete window is parse_unavailable, not 0%", () => {
  const snap = projectCodexRateLimitsReadSnapshot({
    outcome: {
      kind: "ok",
      result: {
        rateLimits: {
          primary: { usedPercent: 42, resetsAt: null, windowDurationMins: 300 },
        },
      },
    },
    collectorVersion: "test",
    observedAtMs: 1_700_000_000_000,
  });
  const w = snap.accounts[0]!.windows[0]!;
  assert.equal(w.status, "parse_unavailable");
  assert.equal(w.usedRatio, undefined);
  assert.equal(w.resetsAt, undefined);
});
