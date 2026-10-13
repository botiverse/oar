import { expect, test } from "vitest";
import { firstProcess, resultsOf } from "../fixtures/claude-usage.js";
import type { ContextUsage } from "../../packages/oar/src/contracts/session.js";
import { contextUsageOf } from "../../packages/oar/src/observe/usage.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

/*
 * The context is what the root agent's LATEST model call sent (input, cache
 * reads and cache writes), not the turn's `result.usage`: claude sums that
 * over every main-loop call of the turn, so a turn of N tool round trips read
 * about N times the context, past its window (a 1M session read "3.7M / 1M").
 * Frames: tests/fixtures/claude-usage.ts (real, claude 2.1.292, haiku 4.5).
 */

/** `contextUsage()` after each result, folded the way the adapter does. */
function contextAfterResults(frames: readonly JsonRecord[]): (ContextUsage | null)[] {
  const kernel = createSessionKernel("claude-session");
  const after: (ContextUsage | null)[] = [];
  frames.reduce((state, frame) => {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    for (const command of commands) {
      if (command.kind === "frame") { kernel.frame(command.body, { agentPath: command.agentPath }); }
    }
    if (frame.type === "result") { after.push(contextUsageOf(kernel.records(), kernel.sessionId).value); }
    return next;
  }, claudePrompted(initialClaudeProjection));
  return after;
}

const MODEL = "claude-opus-5-5";

function call(index: number, usage: JsonRecord, extra: JsonRecord = {}): JsonRecord[] {
  const id = `toolu_${String(index)}`;
  return [
    { type: "assistant", message: { model: MODEL, id: `msg_${String(index)}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "true" } }], usage }, ...extra },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] }, ...extra },
  ];
}

/** One turn of `calls` tool round trips whose context grows by 1k a call from 100k, and its result as claude sums it. */
function longTurn(calls: number, modelUsage: JsonRecord = {}): JsonRecord[] {
  const frames: JsonRecord[] = [{ type: "system", subtype: "init", model: MODEL }];
  const usages = Array.from({ length: calls }, (_, index) => ({ input_tokens: 5, cache_read_input_tokens: 99_000 + index * 1000, cache_creation_input_tokens: 995, output_tokens: 1 }));
  const total = (key: keyof (typeof usages)[number]): number => usages.reduce((sum, usage) => sum + usage[key], 0);
  const sum = { input_tokens: total("input_tokens"), cache_read_input_tokens: total("cache_read_input_tokens"), cache_creation_input_tokens: total("cache_creation_input_tokens"), output_tokens: total("output_tokens") };
  frames.push(...usages.flatMap((usage, index) => call(index, usage)), {
    type: "result", subtype: "success", is_error: false, num_turns: calls, result: "done", usage: sum,
    modelUsage: { ...modelUsage, [MODEL]: { inputTokens: sum.input_tokens, outputTokens: sum.output_tokens, cacheReadInputTokens: sum.cache_read_input_tokens, cacheCreationInputTokens: sum.cache_creation_input_tokens, contextWindow: 1_000_000 } },
  });
  return frames;
}

test("a turn of two main-loop calls reads the last call's context, not the turn's sum (recorded)", () => {
  // Turn 1 called the model twice around a Task subagent: 10+13899+7517, then 8+21416+1026.
  const [first] = resultsOf(firstProcess);
  expect(first?.usage).toMatchObject({ input_tokens: 18, cache_read_input_tokens: 35_315, cache_creation_input_tokens: 8543 });
  // claude itself keeps the last call in `usage.iterations`: 8 + 21416 + 1026 = 22,450.
  expect(first?.usage).toMatchObject({ iterations: [{ input_tokens: 8, cache_read_input_tokens: 21_416, cache_creation_input_tokens: 1026 }] });
  const [afterSubagent, afterPlain] = contextAfterResults(firstProcess);
  expect(afterSubagent).toEqual({ tokens: 22_450, contextWindow: 200_000, percent: 11 });
  // One call: the sum is that call.
  expect(afterPlain).toEqual({ tokens: 22_563, contextWindow: 200_000, percent: 11 });
});

test("thirty tool round trips on a 1M window read 129k (13%), not 3.4M (344%)", () => {
  expect(contextAfterResults(longTurn(30))).toEqual([{ tokens: 129_000, contextWindow: 1_000_000, percent: 13 }]);
});

test("the window is the main loop's model's, not the first model in modelUsage", () => {
  const haikuFirst = { "claude-haiku-4-5-20251001": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200_000 } };
  expect(contextAfterResults(longTurn(1, haikuFirst))).toEqual([{ tokens: 100_000, contextWindow: 1_000_000, percent: 10 }]);
});

test("a subagent's calls are not the root's context", () => {
  const frames = longTurn(1);
  const subagent = call(9, { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 400_000, output_tokens: 1 }, { parent_tool_use_id: "toolu_0" });
  frames.splice(-1, 0, ...subagent);
  expect(contextAfterResults(frames)).toEqual([{ tokens: 100_000, contextWindow: 1_000_000, percent: 10 }]);
});

test("a message claude makes up (`<synthetic>`, zero usage) is not a model call", () => {
  const frames = longTurn(1);
  const synthetic = { type: "assistant", message: { model: "<synthetic>", id: "synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "No response requested." }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } };
  frames.splice(-1, 0, synthetic);
  expect(contextAfterResults(frames)).toEqual([{ tokens: 100_000, contextWindow: 1_000_000, percent: 10 }]);
});

test("/compact makes the context unknown until the next call; a turn without a call leaves it as it was", () => {
  // Recorded: the /compact turn's result reports zero usage (no main-loop call), after a compact_boundary.
  const afterCompact = contextAfterResults(firstProcess).at(-1);
  expect(resultsOf(firstProcess).at(-1)?.usage).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  expect(afterCompact).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
  // A turn that called no model and compacted nothing (a local command) reports no new context.
  const local = { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, modelUsage: {} };
  expect(contextAfterResults([...longTurn(1), local])).toEqual([
    { tokens: 100_000, contextWindow: 1_000_000, percent: 10 },
    { tokens: 100_000, contextWindow: 1_000_000, percent: 10 },
  ]);
});

test("an auto-compaction mid-turn reads the call after it", () => {
  const frames = longTurn(2);
  const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 101_000, post_tokens: 3000 } };
  const afterCompaction = call(2, { input_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 3000, output_tokens: 1 });
  frames.splice(-1, 0, boundary, ...afterCompaction);
  expect(contextAfterResults(frames)).toEqual([{ tokens: 23_005, contextWindow: 1_000_000, percent: 2 }]);
});
