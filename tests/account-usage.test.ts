import assert from "node:assert/strict";
import test from "node:test";
import { projectClaudeUsage } from "../packages/oar/src/runtimes/claude/account-usage.js";
import { projectCodexUsage } from "../packages/oar/src/runtimes/codex/account-usage.js";

test("codex projection preserves typed rate-limit windows", () => {
  const snapshot = projectCodexUsage({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 25, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    },
  });
  assert.equal(snapshot.kind, "available");
  assert.equal(snapshot.plan, "plus");
  const [window] = snapshot.windows;
  assert.ok(window);
  assert.equal(window.usedRatio, 0.25);
});

test("claude projection accepts windows with and without reset text", () => {
  const snapshot = projectClaudeUsage(
    "Current session: 7% used · resets Aug 21 at 7:39pm (Asia/Shanghai)\n"
      + "Current week (Fable): 0% used",
  );
  assert.equal(snapshot.kind, "available");
  assert.deepEqual(snapshot.windows, [
    { label: "Current session", usedRatio: 0.07 },
    { label: "Current week (Fable)", usedRatio: 0 },
  ]);
});
