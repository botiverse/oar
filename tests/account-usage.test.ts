import assert from "node:assert/strict";
import test from "node:test";
import { projectClaudeUsage } from "../packages/oar/src/runtimes/claude/account-usage.js";
import { projectCodexUsage } from "../packages/oar/src/runtimes/codex/account-usage.js";

const options = {
  collectorVersion: "test",
  localAccountSlot: "fixture",
  observedAtMs: Date.UTC(2026, 0, 1),
};

test("codex projection preserves typed rate-limit windows", () => {
  const snapshot = projectCodexUsage({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 25, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    },
  }, options);
  assert.equal(snapshot.runtime, "codex");
  const [account] = snapshot.accounts;
  assert.ok(account);
  assert.equal(account.planLabel, "plus");
  const [window] = account.windows;
  assert.ok(window);
  assert.equal(window.usedRatio, 0.25);
});

test("claude projection refuses to invent a non-UTC reset instant", () => {
  const snapshot = projectClaudeUsage(
    "Current session: 12% used · resets Aug 10 at 10:30pm (America/Chicago)",
    options,
  );
  assert.equal(snapshot.runtime, "claude");
  const [account] = snapshot.accounts;
  assert.ok(account);
  const [window] = account.windows;
  assert.ok(window);
  assert.equal(window.status, "parse_unavailable");
  assert.equal(window.resetsAt, undefined);
});
