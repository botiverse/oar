/* oxlint-disable import/max-dependencies, eslint/max-statements -- One cross-runtime contract test covering every adapter's closing-frame order and recorded replay streams. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai-durable";
import type { ConversationId, ConversationView, LiveState, TaskId, WatchCall } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { Frame, RawEvent, RuntimeEventBody } from "../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../packages/oar/src/observe/index.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../packages/oar/src/runtimes/claude/projection.js";
import { foldCodexNotification, initialCodexProjection } from "../packages/oar/src/runtimes/codex/projection.js";
import { cursorRunResultFrame, foldCursorDelta, initialCursorProjection } from "../packages/oar/src/runtimes/cursor/projection.js";
import { foldDsh, initialDshProjection } from "../packages/oar/src/runtimes/dsh/projection.js";
import { foldFactoryNotification, initialFactoryProjection } from "../packages/oar/src/runtimes/factory/projection.js";
import { grokAcpProfile, grokContextUsage, grokPromptTokens } from "../packages/oar/src/runtimes/grok/session.js";
import { foldPiEvent, initialPiProjection, piPrompted } from "../packages/oar/src/runtimes/pi/projection.js";
import { foldDurableView, initialDurableProjection } from "../packages/oar/src/runtimes/pi-durable/projection.js";
import { initialQoderProjection, qoderProjectionProfile } from "../packages/oar/src/runtimes/qoder/projection.js";
import { initialQwenProjection, qwenProjectionProfile } from "../packages/oar/src/runtimes/qwen/projection.js";
import { CybionClient } from "../packages/oar/src/community/cybion/client.js";
import { createThreadTracker } from "../packages/oar/src/community/cybion/tracker.js";
import { foldMorphTask, initialMorphProjection, morphContextEvents } from "../packages/oar/src/community/morph/projection.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { foldStreamJsonStdout } from "../packages/oar/src/shared/stream-json/projection.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import { assertTurnEndedLast } from "../sea-trial/harness/stream-order.js";
import { fixture as acpFixture, profile as acpProfile, start as startAcp } from "./fixtures/acp-session-support.js";

const fixturesDir = path.join(import.meta.dirname, "replay", "fixtures");

function isConversationId(value: number): value is ConversationId { return Number.isSafeInteger(value) && value > 0; }
function isTaskId(value: number): value is TaskId { return Number.isSafeInteger(value) && value > 0; }

function frameRecord(seq: number, type: string, events: readonly RuntimeEventBody[]): Frame {
  return { kind: "frame", sessionId: "s-1", agentPath: [], seq, receivedAt: seq, body: { type, native: {}, events } };
}

function hasClosingUsage(events: readonly RuntimeEventBody[]): boolean {
  return events.some((event) => event.kind === "turn_ended") && events.some((event) => event.kind === "usage");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") { return input; }
  return input instanceof URL ? input.href : input.url;
}

function replayLines(file: string): readonly string[] {
  return readFileSync(path.join(fixturesDir, file), "utf8").split("\n").filter((entry) => entry.trim().length > 0);
}

test("contract helper rejects any event after turn_ended without an intervening turn_active, and allows next-turn events after turn_active", () => {
  const usage: RuntimeEventBody = { kind: "usage", usage: { tokens: { input: 10, output: 5 } } };
  const ended: RuntimeEventBody = { kind: "turn_ended", outcome: { kind: "completed" } };
  const active: RuntimeEventBody = { kind: "turn_active" };
  const text: RuntimeEventBody = { kind: "text_delta", text: "hi" };
  const tier: RuntimeEventBody = { kind: "service_tier", serviceTier: "default" };

  expect(() => { assertTurnEndedLast([frameRecord(0, "ok", [usage, ended])]); }).not.toThrow();
  expect(() => { assertTurnEndedLast([frameRecord(0, "handover", [usage, ended, active, usage])]); }).not.toThrow();
  expect(() => { assertTurnEndedLast([frameRecord(0, "bad-usage", [ended, usage])]); }).toThrow(/usage after turn_ended/u);
  expect(() => { assertTurnEndedLast([frameRecord(0, "bad-gap", [ended, text, usage])]); }).toThrow(/text_delta after turn_ended/u);
  expect(() => { assertTurnEndedLast([frameRecord(0, "bad-second", [usage, ended, active, ended, usage])]); }).toThrow(/usage after turn_ended/u);
  expect(() => { assertTurnEndedLast([frameRecord(0, "bad-tier", [ended, tier])]); }).toThrow(/service_tier after turn_ended/u);
});

test("recorded Claude replay fixtures emit usage before turn_ended in every closing frame", () => {
  const files = readdirSync(fixturesDir).filter((name) => name.startsWith("claude-") && name.endsWith(".raw.jsonl"));
  expect(files.length).toBeGreaterThan(0);
  let sawClosingUsage = false;
  for (const file of files) {
    let state = claudePrompted(initialClaudeProjection);
    const records: RawEvent[] = [];
    let seq = 0;
    for (const line of replayLines(file)) {
      const native = asRecord(parseJson(line));
      assert.ok(native !== null);
      const { state: nextState, commands } = foldClaudeStdout(state, native);
      state = nextState;
      for (const command of commands) {
        if (command.kind === "frame") {
          const { events, type } = command.body;
          sawClosingUsage ||= hasClosingUsage(events);
          records.push(frameRecord(seq++, `${file}:${type}`, events));
        }
      }
    }
    assertTurnEndedLast(records);
  }
  expect(sawClosingUsage).toBe(true);
});

test("recorded Pi replay fixtures emit context usage before turn_ended on agent_settled", () => {
  const files = readdirSync(fixturesDir).filter((name) => name.startsWith("pi-") && name.endsWith(".raw.jsonl"));
  expect(files.length).toBeGreaterThan(0);
  let sawClosingUsage = false;
  for (const file of files) {
    let state = piPrompted(initialPiProjection);
    const records: RawEvent[] = [];
    let seq = 0;
    for (const line of replayLines(file)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Recorded Pi SDK stream fixture.
      const event = parseJson(line) as AgentSessionEvent;
      const extra = event.type === "agent_settled" ? { context: { tokens: 120, contextWindow: 1000, percent: 12 } } : {};
      const { state: nextState, commands } = foldPiEvent(state, event, extra);
      state = nextState;
      for (const command of commands) {
        const { events, type } = command.body;
        sawClosingUsage ||= hasClosingUsage(events);
        records.push(frameRecord(seq++, `${file}:${type}`, events));
      }
    }
    assertTurnEndedLast(records);
  }
  expect(sawClosingUsage).toBe(true);
});

test("recorded Codex replay fixtures never emit usage after turn_ended", () => {
  const files = readdirSync(fixturesDir).filter((name) => name.startsWith("codex-") && name.endsWith(".raw.jsonl"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    let state = initialCodexProjection("thread-1");
    const records: RawEvent[] = [];
    for (const line of replayLines(file)) {
      const entry = asRecord(parseJson(line));
      const method = typeof entry?.method === "string" ? entry.method : null;
      const params = asRecord(entry?.params);
      if (method !== null && params !== null) {
        const { state: nextState, commands } = foldCodexNotification(state, method, params);
        state = nextState;
        const base = records.length;
        const frames = commands.filter((command) => command.kind === "frame");
        records.push(...frames.map((command, offset) => frameRecord(base + offset, `${file}:${command.body.type}`, command.body.events)));
      }
    }
    assertTurnEndedLast(records);
  }
});

test("ACP closing prompt frame emits usage before turn_ended, and keeps deferred next-turn turn_active after turn_ended", async () => {
  const session = await startAcp({ promptContextUsage: grokContextUsage, promptTokenUsage: grokPromptTokens });
  try {
    const run = await promptAndWait(session, "grok-usage");
    expect(run.kind).toBe("ended");
    const closing = session.records().filter((record): record is Frame => record.kind === "frame" && record.body.type === "session/prompt");
    expect(closing).toHaveLength(1);
    expect(closing[0]?.body.events.map((event) => event.kind)).toEqual(["usage", "turn_ended"]);
    assertTurnEndedLast(session.records());
  } finally {
    await session.dispose();
  }

  const handover = await startAcp({ ...grokAcpProfile, ...acpProfile({ args: [acpFixture, "grok-native"] }) });
  try {
    const run = await promptAndWait(handover, "race-long");
    expect(run.kind).toBe("ended");
    const closing = handover.records().find((record): record is Frame => record.kind === "frame" && record.body.type === "session/prompt");
    expect(closing?.body.events.map((event) => event.kind).slice(-2)).toEqual(["turn_ended", "turn_active"]);
    assertTurnEndedLast(handover.records());
  } finally {
    await handover.dispose();
  }
});

test("Cybion community adapter emits usage before turn_ended", async () => {
  const baseThread = {
    id: "t1", title: "t", model: "m", reasoning_effort: "low", context_tokens: 15,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_tokens: 0 },
    status: "idle", display_status: "completed", created_at: 1, updated_at: 1,
  };
  let polls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    await Promise.resolve();
    if (requestUrl(input).endsWith("/history")) {
      return Response.json([{ id: 2, thread_id: "t1", kind: "response_output", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "ok" }] }, created_at: 2 }]);
    }
    polls += 1;
    return Response.json({ ...baseThread, status: polls === 1 ? "running" : "idle", display_status: polls === 1 ? "running" : "completed" });
  };
  try {
    const kernel = createSessionKernel("t1");
    const tracker = createThreadTracker({
      client: new CybionClient({ baseUrl: "https://cybion.test", apiKey: "cyb_test_secret" }),
      kernel,
      thread: { native: baseThread, id: "t1", status: "idle", displayStatus: "ready", title: "t", model: "m", effort: "low", contextTokens: 5, usage: { input: 1, output: 1, cacheRead: 0 } },
      seen: 1,
      onIdle: () => undefined,
      wait: async (ms) => { await delay(ms >= 5000 ? ms : 1, undefined, { ref: false }); },
    });
    tracker.follow(1);
    await tracker.settle(5000);
    tracker.close();
    const kinds = kernel.records().flatMap((record) => (record.kind === "frame" ? record.body.events.map((event) => event.kind) : []));
    expect(kinds.lastIndexOf("usage")).toBeGreaterThan(-1);
    expect(kinds.lastIndexOf("usage")).toBeLessThan(kinds.indexOf("turn_ended"));
    assertTurnEndedLast(kernel.records());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qwen, Qoder, Factory, Cursor, DSH, Pi Durable and Morph closing frames emit usage before turn_ended", () => {
  const qwen = foldStreamJsonStdout(qwenProjectionProfile, initialQwenProjection(), {
    type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 5 },
  });
  const qoder = foldStreamJsonStdout(qoderProjectionProfile, initialQoderProjection(true), {
    type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 5 },
  });
  const factory = foldFactoryNotification(initialFactoryProjection, {
    method: "droid.session_notification",
    params: { notification: { type: "agent_turn_completed", reason: "completed", turnId: "t-1", tokenUsage: { inputTokens: 10, outputTokens: 5 } } },
  });
  const cursorDelta = foldCursorDelta(initialCursorProjection, { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 5 } });
  const cursorEnd = cursorRunResultFrame({ id: "run-1", status: "finished" });
  const dshUsage = foldDsh(initialDshProjection("d-1"), { type: "native", channel: "session/event", event: { type: "assistant/message", data: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } } });
  const dshEnd = foldDsh(dshUsage.state, { type: "native", channel: "session/event", event: { type: "turn/end", data: { reason: { kind: "completed" } } } });
  const morphContext = morphContextEvents({ context: { available: true, used_input_tokens: 10, context_window_tokens: 100, usage_ratio: 0.1 } });
  const morphEnd = foldMorphTask(initialMorphProjection, { id: "task-1", status: "done", result: { final: { output: "ok" } } });

  const convId = 1; const t1 = 1; const t2 = 2;
  assert.ok(isConversationId(convId) && isTaskId(t1) && isTaskId(t2));
  const durableUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } satisfies Usage;
  const emptyView: ConversationView = { conversation: { id: convId }, entries: [], docs: { "pi.live": { run: { taskId: t1, inputs: [], turns: 1 } } satisfies LiveState, "pi.agent": {}, "pi.usage": { models: {}, tools: {} } } };
  const handoverView: ConversationView = { conversation: { id: convId }, entries: [], docs: { "pi.live": { run: { taskId: t2, inputs: [], turns: 1 } } satisfies LiveState, "pi.agent": {}, "pi.usage": { models: { m: durableUsage }, tools: {} } } };
  const watchCall: Extract<WatchCall<ConversationView>, { kind: "value" }> = { kind: "value", value: handoverView, ops: [["d", ["docs", "pi.live", "run"]]], retired: false };
  const durable = foldDurableView(initialDurableProjection(emptyView), watchCall, [], false, { kind: "completed" });
  expect(durable.frame.events.map((event) => event.kind)).toEqual(["usage", "turn_ended", "turn_active"]);

  const records: RawEvent[] = [
    ...qwen.commands.flatMap((cmd, index) => (cmd.kind === "frame" ? [frameRecord(index, "qwen/result", cmd.body.events)] : [])),
    ...qoder.commands.flatMap((cmd, index) => (cmd.kind === "frame" ? [frameRecord(10 + index, "qoder/result", cmd.body.events)] : [])),
    frameRecord(20, factory.body.type, factory.body.events),
    frameRecord(30, cursorDelta.frame.type, cursorDelta.frame.events),
    frameRecord(31, cursorEnd.type, cursorEnd.events),
    frameRecord(40, dshUsage.frame.body.type, dshUsage.frame.body.events),
    frameRecord(41, dshEnd.frame.body.type, dshEnd.frame.body.events),
    frameRecord(50, "topic/metadata", morphContext),
    frameRecord(51, "task/done", morphEnd.events),
    frameRecord(60, durable.frame.type, durable.frame.events),
  ];
  assertTurnEndedLast(records);
});

test("scriptedRuntime and mock session emit usage before turn_ended", async () => {
  const scripted = await scriptedRuntime({ turn: ({ say }) => { say("ok"); } }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  try {
    const run = await promptAndWait(scripted, "hello");
    expect(run.kind).toBe("ended");
    assertTurnEndedLast(scripted.records());
  } finally {
    await scripted.dispose();
  }

  const mock = await startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  try {
    const run = await promptAndWait(mock, "hello");
    expect(run.kind).toBe("ended");
    assertTurnEndedLast(mock.records());
  } finally {
    await mock.dispose();
  }
});
