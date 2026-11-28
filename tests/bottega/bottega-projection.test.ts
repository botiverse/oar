import { expect, test } from "vitest";
import type { RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import { bottegaTurnOutcome, foldBottega, initialBottegaProjection, type BottegaProjection } from "../../packages/oar/src/runtimes/bottega/projection.js";

// Lines as `bottega serve` wrote them on 2026-11-12 (bottega 0.2.0, protocol 1), trimmed.
function replay(lines: readonly Record<string, unknown>[]): { state: BottegaProjection; events: RuntimeEventBody[]; types: string[] } {
  let state = initialBottegaProjection;
  const events: RuntimeEventBody[] = [];
  const types: string[] = [];
  for (const line of lines) {
    const folded = foldBottega(state, line);
    ({ state } = folded);
    expect(folded.body.native).toBe(line);
    types.push(folded.body.type);
    events.push(...folded.body.events);
  }
  return { state, events, types };
}

test("a person's turn: the line, the turn, what the agent did and said, what it cost, the end", () => {
  const { state, events, types } = replay([
    { type: "said", id: "m1", step: 0, who: "user", text: "hello", inputId: "i1" },
    { type: "turn_started", step: 0, inputId: "i1" },
    { type: "action", id: "s1.0", step: 1, tool: "unsent", args: "", note: "let me look" },
    { type: "action", id: "s1.1", step: 1, tool: "files_read", args: "{\"path\":\"a.md\"}", note: "w3: 12 lines" },
    { type: "step", step: 1, provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 5, cost: 0.001 }, promptTokens: 140, contextBudget: 64_000 },
    { type: "said", id: "m2", step: 2, who: "agent", text: "hi" },
    { type: "step", step: 2, provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", usage: { input: 20, output: 5, cacheRead: 150, cacheWrite: 0, cost: 0.0002 }, promptTokens: 170, contextBudget: 64_000 },
    { type: "note", text: "(the agent stopped without saying anything)" },
    { type: "turn_ended", step: 2, outcome: "completed", inputIds: ["i1"] },
  ]);
  expect(types.at(0)).toBe("bottega/said");
  expect(types.at(-2)).toBe("bottega/note");
  expect(events).toEqual([
    { kind: "user_message", input: "hello", inputId: "i1", nativeMessageId: "m1", evidence: "conversation" },
    { kind: "turn_active", inputId: "i1" },
    { kind: "reasoning", content: { kind: "text", text: "let me look" } },
    { kind: "tool_call_started", callId: "s1.1", tool: "files_read", input: "{\"path\":\"a.md\"}" },
    { kind: "tool_call_ended", callId: "s1.1", content: [{ type: "text", text: "w3: 12 lines" }] },
    { kind: "model", model: "openrouter/deepseek/deepseek-v4.1-flash" },
    { kind: "usage", usage: { tokens: { input: 145, output: 10, cacheRead: 40, cacheWrite: 5 }, context: { tokens: 145, contextWindow: 64_000, percent: 0 } } },
    { kind: "text_delta", text: "hi", messageId: "m2" },
    { kind: "usage", usage: { tokens: { input: 315, output: 15, cacheRead: 190, cacheWrite: 5 }, context: { tokens: 170, contextWindow: 64_000, percent: 0 } } },
    { kind: "turn_ended", outcome: { kind: "completed" }, inputIds: ["i1"] },
  ]);
  expect(state).toEqual({ turnOpen: false, model: "openrouter/deepseek/deepseek-v4.1-flash", tokens: { input: 315, output: 15, cacheRead: 190, cacheWrite: 5 } });
});

test("the turn is open between its start and its end", () => {
  expect(replay([{ type: "turn_started", step: 0 }]).state.turnOpen).toBe(true);
  expect(replay([{ type: "turn_started", step: 0 }, { type: "turn_ended", step: 1, outcome: "aborted", inputIds: [] }]).state.turnOpen).toBe(false);
});

test("a turn's end in bottega's word: a cap is the step limit, a failure's prose is not classified", () => {
  expect(bottegaTurnOutcome({ outcome: "completed" })).toEqual({ kind: "completed" });
  expect(bottegaTurnOutcome({ outcome: "aborted" })).toEqual({ kind: "aborted" });
  expect(bottegaTurnOutcome({ outcome: "capped", reason: "stopped at 30 steps" })).toEqual({ kind: "failed", failure: "limit_reached", reason: "stopped at 30 steps" });
  expect(bottegaTurnOutcome({ outcome: "failed", reason: "the agent hit an error: inference error: 429" })).toEqual({ kind: "failed", failure: "unknown", reason: "the agent hit an error: inference error: 429" });
  expect(bottegaTurnOutcome({ outcome: "paused" })).toEqual({ kind: "failed", failure: "unknown", reason: "bottega ended the turn with \"paused\"" });
});

test("an event bottega declined comes back to its sender; one without an identity only enters the stream", () => {
  expect(replay([{ type: "input_dropped", inputId: "i9", reason: "you stopped the agent" }]).events).toEqual([
    { kind: "input_dropped", reason: "runtime_refused", inputId: "i9", message: "you stopped the agent" },
  ]);
  expect(replay([{ type: "input_dropped", reason: "you stopped the agent" }]).events).toEqual([]);
});

test("a line this does not know enters the stream and says nothing", () => {
  const { events, types } = replay([{ type: "ready", protocol: 1, version: "0.2.0" }, { type: "later-addition", detail: 1 }, { line: "not a typed line" }]);
  expect(events).toEqual([]);
  expect(types).toEqual(["bottega/ready", "bottega/later-addition", "bottega/line"]);
});

test("a step without usage reports its route and no tokens", () => {
  expect(replay([{ type: "step", step: 1, provider: "faux", model: "faux", usage: null }]).events).toEqual([{ kind: "model", model: "faux/faux" }]);
});
