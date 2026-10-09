import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { firstProcess, getUsageAnswer, resultsOf as results, resumedProcess, savedModelUsage } from "../fixtures/claude-usage.js";
import type { RuntimeEventBody, SessionUsage } from "../../packages/oar/src/contracts/session.js";
import { initialSessionView, reduceSessionView } from "../../packages/oar/src/observe/session-view.js";
import { usageOf } from "../../packages/oar/src/observe/usage.js";
import { claudeUsageBaseline } from "../../packages/oar/src/runtimes/claude/token-usage.js";
import {
  claudePrompted,
  claudeUsageBaselined,
  foldClaudeStdout,
  initialClaudeProjection,
  resumedClaudeProjection,
  type ClaudeProjectionState,
} from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { createSessionKernel, type SessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

/*
 * claude's session total is its latest `result.modelUsage`, the root agent's
 * entry its main loop (`result.usage`), and the rest unattributed (#282).
 * Frames: tests/fixtures/claude-usage.ts (real, but the get_usage answer).
 */

/** Fold claude frames into a kernel the way the adapter does; the usage() answer after each result. */
function replay(lines: readonly JsonRecord[], start: ClaudeProjectionState = claudePrompted(initialClaudeProjection)): { afterResults: SessionUsage[]; kernel: SessionKernel } {
  const kernel = createSessionKernel("claude-session");
  const afterResults: SessionUsage[] = [];
  lines.reduce((state, frame) => {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    for (const command of commands) {
      if (command.kind === "frame") { kernel.frame(command.body, { agentPath: command.agentPath }); }
    }
    if (frame.type === "result") { afterResults.push(usageOf(kernel.records(), kernel.sessionId).value); }
    return next;
  }, start);
  return { afterResults, kernel };
}

/** A resumed session's fold once its get_usage read-back has `answered`. */
const resumedAfter = (answered: JsonRecord | Error): ClaudeProjectionState => claudeUsageBaselined(resumedClaudeProjection, claudeUsageBaseline(answered));
const baselineFrom = (modelUsage: unknown): unknown => claudeUsageBaseline(getUsageAnswer("oar-usage-1", modelUsage));

function usageEvents(state: ClaudeProjectionState, frame: JsonRecord): RuntimeEventBody[] {
  return foldClaudeStdout(state, frame).commands.flatMap((command) => command.kind === "frame" ? command.body.events.filter((event) => event.kind === "usage") : []);
}

const root = (tokens: SessionUsage["total"]): unknown => [{ agentPath: [], tokens }];

test("a new session's total is claude's latest modelUsage: the root keeps its main loop, the subagent's spend is unattributed", () => {
  const [afterSubagent, afterPlain] = replay(firstProcess).afterResults;
  // Turn 1 ran a Task subagent: modelUsage (69147 in) exceeds the main loop's result.usage (43876 in) by the subagent's calls.
  expect(afterSubagent).toEqual({
    total: { input: 69_147, output: 1011, cacheRead: 47_627, cacheWrite: 21_484 },
    byAgent: root({ input: 43_876, output: 834, cacheRead: 35_315, cacheWrite: 8543 }),
    unattributed: { input: 25_271, output: 177, cacheRead: 12_312, cacheWrite: 12_941 },
  });
  // Turn 2 is plain: modelUsage carries the running total (read, not added), grown by exactly the main loop's turn.
  expect(afterPlain).toEqual({
    total: { input: 91_710, output: 1040, cacheRead: 70_069, cacheWrite: 21_595 },
    byAgent: root({ input: 66_439, output: 863, cacheRead: 57_757, cacheWrite: 8654 }),
    unattributed: { input: 25_271, output: 177, cacheRead: 12_312, cacheWrite: 12_941 },
  });
});

test("the session view reads the same usage as usage()", () => {
  const { kernel, afterResults } = replay(firstProcess);
  const view = kernel.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
  expect(view.usage).toEqual(afterResults.at(-1));
});

test("a subagent gets no entry of its own: its one attributed frame carries a stream-start usage, not its spend", () => {
  const { kernel, afterResults } = replay(firstProcess);
  const attributed = kernel.records().filter((record) => record.agentPath.length > 0);
  // Only the subagent's first assistant frame carries parent_tool_use_id; its output_tokens is the stream's start.
  const assistant = attributed.flatMap((record) => record.kind === "frame" && record.body.type === "assistant" ? [asRecord(asRecord(record.body.native)?.message)?.usage] : []);
  expect(assistant).toEqual([expect.objectContaining({ input_tokens: 10, output_tokens: 3 })]);
  expect(afterResults.flatMap((usage) => usage.byAgent ?? []).every((entry) => entry.agentPath.length === 0)).toBe(true);
});

test("/compact grows the total while the main loop reports nothing: compaction is unattributed", () => {
  const afterCompact = replay(firstProcess).afterResults.at(-1);
  expect(results(firstProcess).at(-1)?.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  expect(afterCompact).toEqual({
    total: { input: 115_697, output: 2213, cacheRead: 92_511, cacheWrite: 21_669 },
    byAgent: root({ input: 66_439, output: 863, cacheRead: 57_757, cacheWrite: 8654 }),
    unattributed: { input: 49_258, output: 1350, cacheRead: 34_754, cacheWrite: 13_015 },
  });
});

test("a resumed session counts from claude's get_usage baseline: its total is its own turn, not the session's life", () => {
  // The resumed process's first result continues the previous process's running total.
  expect(results(resumedProcess)[0]?.modelUsage).toMatchObject({ "claude-haiku-4-5-20251001": { inputTokens: 1527, outputTokens: 2249, cacheReadInputTokens: 110_477, cacheCreationInputTokens: 25_780 } });
  const answered = getUsageAnswer("oar-usage-1", savedModelUsage);
  const resumed = replay(resumedProcess, claudePrompted(resumedAfter(answered)));
  const own = { input: 22_087, output: 36, cacheRead: 17_966, cacheWrite: 4111 };
  expect(resumed.afterResults).toEqual([{ total: own }]);
  // That is exactly this Session's main loop: 10 + 17966 + 4111 in, 36 out.
  expect(results(resumedProcess)[0]?.usage).toMatchObject({ input_tokens: 10, cache_read_input_tokens: 17_966, cache_creation_input_tokens: 4111, output_tokens: 36 });
});

test.each([
  ["no answer yet", resumedClaudeProjection],
  ["an error answer", resumedAfter({ type: "control_response", response: { subtype: "error", request_id: "oar-usage-1", error: "Unsupported control request subtype: get_usage" } })],
  ["a timeout", resumedAfter(new Error("claude did not answer get_usage within 30000 ms"))],
  ["an answer without session totals", resumedAfter(getUsageAnswer("oar-usage-1", undefined))],
])("a resume without a baseline (%s) reports context only, and usage().total stays null", (_case, start) => {
  const result = results(resumedProcess)[0] ?? {};
  expect(usageEvents(start, result)).toEqual([{ kind: "usage", usage: { context: { tokens: 22_087, contextWindow: 200_000, percent: 11 } } }]);
  expect(replay(resumedProcess, start).afterResults).toEqual([{ total: null }]);
});

test("get_usage sets a baseline only from session.model_usage, whole", () => {
  expect(baselineFrom({})).toEqual({ kind: "known", models: new Map() });
  const saved = new Map([["claude-haiku-4-5-20251001", { input: 115_697, output: 2213, cacheRead: 92_511, cacheWrite: 21_669 }]]);
  expect(baselineFrom(savedModelUsage)).toEqual({ kind: "known", models: saved });
  // An entry without its counts makes the whole baseline unknown, never a partial one.
  expect(baselineFrom({ "claude-haiku-4-5": { inputTokens: 1 } })).toEqual({ kind: "unknown" });
});

test("a zeroed startup-error result never moves the total back", () => {
  // claude 2.1.292's missing-session result: zeroed usage and `modelUsage: {}`.
  const recorded = readFileSync(new URL("../fixtures/claude-missing-resume.json", import.meta.url), "utf8");
  const zeroed = asRecord(JSON.parse(recorded)) ?? {};
  expect(zeroed.modelUsage).toEqual({});
  const { afterResults } = replay([...firstProcess, zeroed]);
  expect(afterResults.at(-1)).toEqual(afterResults.at(-2));
});

test("claude resetting its running total (a /clear) keeps what this Session counted before it", () => {
  // SYNTHETIC: claude 2.1.289's schema says "a mid-session /clear resets the running total"; not recorded yet.
  const afterClear = { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
    modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 100, webSearchRequests: 0, costUSD: 0.0002, contextWindow: 200_000, maxOutputTokens: 32_000 } } };
  const { afterResults } = replay([...firstProcess, afterClear]);
  expect(afterResults.at(-1)).toEqual({
    total: { input: 115_802, output: 2220, cacheRead: 92_511, cacheWrite: 21_769 },
    byAgent: root({ input: 66_544, output: 870, cacheRead: 57_757, cacheWrite: 8754 }),
    unattributed: { input: 49_258, output: 1350, cacheRead: 34_754, cacheWrite: 13_015 },
  });
});
