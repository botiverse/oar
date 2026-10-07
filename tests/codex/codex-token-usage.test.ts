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

/** The root token totals a Session's projection reads out of `frames`, opened by `opened`. */
function sessionTokens(opened: "thread/start" | "thread/resume", frames: readonly (readonly [string, Record<string, unknown>])[]): unknown[] {
  let state = initialCodexProjection(ROOT, opened);
  return frames.flatMap(([method, params]) => {
    const folded = foldCodexNotification(state, method, { threadId: ROOT, ...params });
    ({ state } = folded);
    return usageTokens(folded.commands);
  });
}

const total = (input: number, output: number, cache?: { readonly read: number; readonly write: number }): Record<string, unknown> => ({
  tokenUsage: { total: { inputTokens: input, outputTokens: output, ...(cache === undefined ? {} : { cachedInputTokens: cache.read, cacheWriteInputTokens: cache.write }) } },
});

// #169, from a real codex-cli 0.155.1 login (botiverse/ferry fixture
// packages/core/test/fixtures/codex-resume.jsonl): run 1 ended at
// 18,185 / 5. The resumed run re-reported 18,185 / 5 under run 1's turn id
// right after the prompt, before turn/started, then 38,557 / 10.
test("a resumed codex Session counts its tokens from the total re-reported before its first turn", () => {
  expect(sessionTokens("thread/resume", [
    ["thread/tokenUsage/updated", { turnId: "run-1-turn", ...total(18_185, 5) }],
    ["turn/started", { turn: { id: "run-2-turn" } }],
    ["thread/tokenUsage/updated", { turnId: "run-2-turn", ...total(38_557, 10) }],
  ])).toEqual([{ input: 0, output: 0 }, { input: 20_372, output: 5 }]);
});

// Numbers made up: the cache parts are subtracted like input.
test("the resume baseline is subtracted from cacheRead and cacheWrite too", () => {
  expect(sessionTokens("thread/resume", [
    ["thread/tokenUsage/updated", total(30_000, 40, { read: 20_000, write: 9000 })],
    ["turn/started", { turn: { id: "t2" } }],
    ["thread/tokenUsage/updated", total(42_000, 70, { read: 31_000, write: 9500 })],
  ])).toEqual([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 12_000, output: 30, cacheRead: 11_000, cacheWrite: 500 }]);
});

// No re-report, no baseline: codex 0.131.0 to 0.150.1 send none, and 0.118.0
// to 0.130.0 re-report inside the first turn, under its own id (codex-aimock
// probes, experiments/codex-resume-usage.ts). Neither is subtracted, so the
// totals stay the thread's; a new thread is never baselined.
test("a codex total that arrives after the first turn started is never a baseline", () => {
  expect(sessionTokens("thread/resume", [
    ["turn/started", { turn: { id: "t2" } }],
    ["thread/tokenUsage/updated", { turnId: "t2", ...total(1000, 5) }],
    ["thread/tokenUsage/updated", { turnId: "t2", ...total(2200, 12) }],
  ])).toEqual([{ input: 1000, output: 5 }, { input: 2200, output: 12 }]);
  expect(sessionTokens("thread/start", [
    ["thread/tokenUsage/updated", total(0, 0)],
    ["turn/started", { turn: { id: "t1" } }],
    ["thread/tokenUsage/updated", total(1000, 5)],
  ])).toEqual([{ input: 0, output: 0 }, { input: 1000, output: 5 }]);
});

// Only the root thread is baselined: a child thread's total is its own, and
// it neither sets nor meets the root's baseline.
test("a child thread's total before the root's first turn is not the root's baseline", () => {
  let state = initialCodexProjection(ROOT, "thread/resume");
  const fold = (threadId: string, method: string, params: Record<string, unknown>): unknown[] => {
    const folded = foldCodexNotification(state, method, { threadId, ...params });
    ({ state } = folded);
    return usageTokens(folded.commands);
  };
  expect([
    ...fold("thread-child", "thread/tokenUsage/updated", total(500, 2)),
    ...fold(ROOT, "thread/tokenUsage/updated", total(1000, 5)),
    ...fold(ROOT, "turn/started", { turn: { id: "t2" } }),
    ...fold("thread-child", "thread/tokenUsage/updated", total(900, 4)),
    ...fold(ROOT, "thread/tokenUsage/updated", total(2200, 12)),
  ]).toEqual([{ input: 500, output: 2 }, { input: 0, output: 0 }, { input: 900, output: 4 }, { input: 1200, output: 7 }]);
});
