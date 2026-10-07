import { expect, test } from "vitest";
import {
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/codex/projection.js";

const ROOT = "thread-root";

/**
 * A `TokenUsageBreakdown` (app-server v2 thread.rs at 4f39251a, camelCase):
 * `inputTokens` holds the cache reads and writes, as codex-api
 * sse/responses.rs fills them from the Responses API's `input_tokens_details`
 * (its test: input 100 = cache read 40 + cache write 60). Numbers made up.
 */
function breakdown(input: number, cache: { readonly read: number; readonly write: number }, output: number): Record<string, number> {
  return { totalTokens: input + output, inputTokens: input, cachedInputTokens: cache.read, cacheWriteInputTokens: cache.write, outputTokens: output, reasoningOutputTokens: 0 };
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
// snapshots: `cachedInputTokens` is `cacheRead` and `cacheWriteInputTokens`
// `cacheWrite`, both parts of `inputTokens`.
test("codex cache reads and writes are the cumulative total's cachedInputTokens and cacheWriteInputTokens", () => {
  const first = tokenUsage(initialCodexProjection(ROOT), { turnId: "t1", tokenUsage: { total: breakdown(10_000, { read: 0, write: 9600 }, 20), last: breakdown(10_000, { read: 0, write: 9600 }, 20), modelContextWindow: 121_600 } });
  const second = tokenUsage(first.state, { turnId: "t2", tokenUsage: { total: breakdown(22_000, { read: 9600, write: 11_900 }, 50), last: breakdown(12_000, { read: 9600, write: 2300 }, 30), modelContextWindow: 121_600 } });
  expect([...first.tokens, ...second.tokens]).toEqual([
    { input: 10_000, output: 20, cacheRead: 0, cacheWrite: 9600 },
    { input: 22_000, output: 50, cacheRead: 9600, cacheWrite: 11_900 },
  ]);
});

// The field names as codex-cli 0.160.0 sent them (codex-aimock run,
// 2026-10-03, ids shortened): a reported 0 stays 0.
test("codex's own zeros stay zeros", () => {
  const zero = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const recorded = tokenUsage(initialCodexProjection(ROOT), { turnId: "t-1", tokenUsage: { total: zero, last: zero, modelContextWindow: 258_400 } });
  expect(recorded.tokens).toEqual([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]);
});

// A codex built before `cacheWriteInputTokens` (openai/codex#33454) has no
// write field: only `cacheRead`, never a guessed `cacheWrite`. A total
// without either field has neither part.
test("an older codex total without cacheWriteInputTokens yields only cacheRead", () => {
  const older = tokenUsage(initialCodexProjection(ROOT), { tokenUsage: { total: { totalTokens: 44_201, inputTokens: 44_166, cachedInputTokens: 32_512, outputTokens: 35, reasoningOutputTokens: 0 } } });
  expect(older.tokens).toEqual([{ input: 44_166, output: 35, cacheRead: 32_512 }]);
  const bare = tokenUsage(initialCodexProjection(ROOT), { tokenUsage: { total: { inputTokens: 200, outputTokens: 5 } } });
  expect(bare.tokens).toEqual([{ input: 200, output: 5 }]);
});
