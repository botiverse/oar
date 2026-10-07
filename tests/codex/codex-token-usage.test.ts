import { expect, test } from "vitest";
import {
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/codex/projection.js";

const ROOT = "thread-root";

/** A `TokenUsageBreakdown` (app-server schema, pinned 4f39251a; numbers made up). */
function breakdown(input: number, cached: number, output: number): Record<string, number> {
  // `cacheWriteInputTokens` is in the schema (serde default 0); oar does not read it.
  return { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 300, outputTokens: output, reasoningOutputTokens: 0 };
}

function usageTokens(commands: readonly ProjectionCommand[]): unknown[] {
  return commands.flatMap((command) => (command.kind === "frame" ? command.body.events : []))
    .flatMap((view) => (view.kind === "usage" && view.usage.tokens !== undefined ? [view.usage.tokens] : []));
}

function tokenUsage(state: CodexProjectionState, params: Record<string, unknown>): { readonly state: CodexProjectionState; readonly tokens: unknown[] } {
  const folded = foldCodexNotification(state, "thread/tokenUsage/updated", { threadId: ROOT, ...params });
  return { state: folded.state, tokens: usageTokens(folded.commands) };
}

// #161: codex's `total` is its own running sum, so two turns read as two
// snapshots. `inputTokens` already holds the cached reads and
// `cachedInputTokens` (a required field) is that part: `cacheRead`. Only
// cache reads are mapped, so no `cacheWrite` appears; a total without
// `cachedInputTokens` (a build that does not report it) has no `cacheRead`.
test("codex cache reads are the cumulative total's cachedInputTokens, and no cacheWrite is read", () => {
  const first = tokenUsage(initialCodexProjection(ROOT), { turnId: "t1", tokenUsage: { total: breakdown(10_000, 0, 20), last: breakdown(10_000, 0, 20), modelContextWindow: 121_600 } });
  const second = tokenUsage(first.state, { turnId: "t2", tokenUsage: { total: breakdown(22_000, 9000, 50), last: breakdown(12_000, 9000, 30), modelContextWindow: 121_600 } });
  expect([...first.tokens, ...second.tokens]).toEqual([
    { input: 10_000, output: 20, cacheRead: 0 },
    { input: 22_000, output: 50, cacheRead: 9000 },
  ]);
  const unreported = tokenUsage(initialCodexProjection(ROOT), { tokenUsage: { total: { inputTokens: 200, outputTokens: 5 } } });
  expect(unreported.tokens).toEqual([{ input: 200, output: 5 }]);
});
