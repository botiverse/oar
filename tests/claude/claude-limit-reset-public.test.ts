import { expect, test } from "vitest";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";
import { claudeInspectLimitResets, claudeRedeemLimitReset } from "../../packages/oar/src/runtimes/claude/limit-reset/index.js";

/*
 * The public members before anything is started: what they refuse without a
 * terminal. The driver itself is tested against recorded screens
 * (claude-limit-reset-driver.test.ts).
 */

const bundled = { kind: "available", via: "bundled" } as const;
const executable = { kind: "available", via: "executable", command: "/nonexistent/claude" } as const;

test("claude declares both limit-reset members", () => {
  expect(claudeRuntime.inspectLimitResets).toBe(claudeInspectLimitResets);
  expect(claudeRuntime.redeemLimitReset).toBe(claudeRedeemLimitReset);
});

test("a redeem without a kind is refused before anything starts: a bare /limit-reset can spend unconfirmed", async () => {
  for (const resetId of [undefined, "", "5-hour", "seven_day", "grant-123"]) {
    // oxlint-disable-next-line no-await-in-loop -- One refusal at a time, each checked on its own.
    await expect(claudeRedeemLimitReset(executable, { idempotencyKey: "k", ...(resetId === undefined ? {} : { resetId }) }))
      .resolves.toEqual({ kind: "unsupported", reason: "reset_id_required" });
  }
});

test("a bundled installation has no CLI UI to drive", async () => {
  await expect(claudeRedeemLimitReset(bundled, { idempotencyKey: "k", resetId: "weekly" })).resolves.toEqual({ kind: "unsupported", reason: "unsupported_installation" });
  await expect(claudeInspectLimitResets(bundled)).resolves.toEqual({ kind: "unsupported", reason: "unsupported_installation" });
});
