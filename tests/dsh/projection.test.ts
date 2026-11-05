/* oxlint-disable eslint/max-lines -- One fold, one table of native shapes. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import alpha from "../../experiments/dsh-plugin/evidence/0.2.2-alpha.2.json" with { type: "json" };
import rc from "../../experiments/dsh-plugin/evidence/0.2.1-rc.5.json" with { type: "json" };
import type { RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { dshFailureClass, dshOpenedFrame, dshTurnOutcome, foldDsh, initialDshProjection, type DshProjection } from "../../packages/oar/src/runtimes/dsh/projection.js";

function replay(lines: readonly JsonRecord[], rootId: string): { readonly state: DshProjection; readonly frames: ReturnType<typeof foldDsh>["frame"][] } {
  let state = initialDshProjection(rootId);
  const frames: ReturnType<typeof foldDsh>["frame"][] = [];
  for (const line of lines) {
    const next = foldDsh(state, line);
    ({ state } = next);
    frames.push(next.frame);
  }
  return { state, frames };
}

const native = (channel: string, fields: JsonRecord, sessionId = "root"): JsonRecord => ({ type: "native", channel, sessionId, ...fields });
const durable = (type: string, data: JsonRecord, options: { readonly sessionId?: string; readonly cause?: string } = {}): JsonRecord => native("session/event", { event: { type, seq: 1, time: 2, data }, ...(options.cause === undefined ? {} : { cause: options.cause }) }, options.sessionId ?? "root");
const message = (id: string): JsonRecord => ({ id, role: "user", content: [{ type: "text", text: id }], source: { kind: "user" } });
const eventsOf = (lines: readonly JsonRecord[]): readonly RuntimeEventBody[] => replay(lines, "root").frames.flatMap((frame) => frame.body.events);

const captures = [["0.2.1-rc.5", rc], ["0.2.2-alpha.2", alpha]] as const;

test.each(captures)("replaying the captured native tool turn of %s keeps every payload verbatim", (_version, evidence) => {
  const { frames } = replay(evidence.basicNativeFrames, "oar-basic");
  expect(frames).toHaveLength(evidence.basicNativeFrames.length);
  for (const [index, frame] of frames.entries()) {
    const line = asRecord(evidence.basicNativeFrames[index]);
    assert.ok(line !== null);
    const { type: _type, channel: _channel, sessionId: _sessionId, ...rest } = line;
    expect(frame.body.native).toEqual(line.event ?? line.frame ?? rest);
  }
});

test.each(captures)("replaying the captured native tool turn of %s reads one copy of the text and the runtime's turn end", (_version, evidence) => {
  const { state, frames } = replay(evidence.basicNativeFrames, "oar-basic");
  const events = frames.flatMap((frame) => frame.body.events);
  expect(events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")).toBe("native final answer");
  expect(events.filter((event) => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  expect(events.flatMap((event) => event.kind === "tool_call_started" || event.kind === "tool_call_ended" ? [event.kind] : [])).toEqual(["tool_call_started", "tool_call_ended"]);
  expect(events.find((event) => event.kind === "model")).toEqual({ kind: "model", model: "oar-probe/probe-model" });
  const session = state.sessions["oar-basic"];
  expect(session?.tokens).toEqual({ input: 200, output: 24 });
  expect(session?.nextTurn).toEqual([]);
  expect(session?.turnOpen).toBe(false);
});

test("an unknown native type stays a frame with no events", () => {
  const { frames } = replay([durable("plugin:future/thing", { any: "shape" }), native("agent/status", { status: "running" }), native("agent/assistant-stream", { frame: { type: "chunk", chunk: { type: "future" } } })], "root");
  expect(frames).toMatchInlineSnapshot(`
    [
      {
        "body": {
          "events": [],
          "native": {
            "data": {
              "any": "shape",
            },
            "seq": 1,
            "time": 2,
            "type": "plugin:future/thing",
          },
          "type": "session/event:plugin:future/thing",
        },
      },
      {
        "body": {
          "events": [],
          "native": {
            "status": "running",
          },
          "type": "agent/status",
        },
      },
      {
        "body": {
          "events": [],
          "native": {
            "chunk": {
              "type": "future",
            },
            "type": "chunk",
          },
          "type": "agent/assistant-stream",
        },
      },
    ]
  `);
});

test("lines that are not native payloads are kept as frames with no events", () => {
  expect(foldDsh(initialDshProjection("root"), { type: "stdout", line: "noise" }).frame.body).toEqual({ type: "dsh/stdout", native: { type: "stdout", line: "noise" }, events: [] });
  expect(foldDsh(initialDshProjection("root"), { type: "ready", protocol: 1 }).frame.body.events).toEqual([]);
});

test("the durable assistant message adds no second text and no second tool start", () => {
  const events = eventsOf([
    native("agent/assistant-stream", { frame: { type: "chunk", attemptId: "a", chunk: { type: "text-delta", text: "hi" } } }),
    durable("assistant/message", { message: { content: [{ type: "text", text: "hi" }, { type: "tool-call", id: "c", name: "n", arguments: "{}" }] } }),
  ]);
  expect(events).toEqual([{ kind: "text_delta", text: "hi", messageId: "a" }]);
});

test("a claim starts the named input's turn; a steer's claim starts nothing; a cancelled splice hands input back; a withdrawal is not a drop", () => {
  const events = eventsOf([
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message("q1")] }),
    durable("turn/start", { turn: 1 }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1, inserted: [] }),
    durable("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [message("s1")] }),
    durable("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1, inserted: [] }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message("q2"), message("q3")] }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 1, removedCount: 1, inserted: [], outcome: "canceled" }, { cause: "withdraw" }),
    durable("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [message("s2")] }),
    durable("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1, inserted: [], outcome: "canceled" }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1, inserted: [], outcome: "canceled" }),
  ]);
  expect(events).toEqual([
    { kind: "turn_active", inputId: "q1" },
    { kind: "input_dropped", inputId: "s2", reason: "turn_interrupted" },
    { kind: "input_dropped", inputId: "q2", reason: "turn_interrupted" },
  ]);
});

test("a prompt behind input a crashed process left waiting is held until its own claim", () => {
  const events = eventsOf([
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message("left")] }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 1, inserted: [message("prompted")] }, { cause: "prompt" }),
    durable("turn/start", { turn: 2 }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1, inserted: [] }),
    durable("turn/end", { turn: 2, reason: { kind: "completed" } }),
    durable("turn/start", { turn: 3 }),
    durable("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1, inserted: [] }),
  ]);
  expect(events).toEqual([
    { kind: "input_queued", inputId: "prompted" },
    { kind: "turn_active", inputId: "left" },
    { kind: "turn_ended", outcome: { kind: "completed" } },
    { kind: "turn_active", inputId: "prompted" },
  ]);
  const alone = durable("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message("only")] }, { cause: "prompt" });
  expect(eventsOf([alone])).toEqual([]);
});

test("a turn with no waiting input is an active turn with no input id", () => {
  expect(eventsOf([durable("turn/start", { turn: 3 })])).toEqual([{ kind: "turn_active" }]);
});

test("a native message id is the input id; runtime context is no user message", () => {
  const events = eventsOf([
    durable("user/message", { id: "i", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], source: { kind: "user" } }),
    durable("user/message", { content: [{ type: "text", text: "cwd" }], source: { kind: "runtime-context" } }),
    durable("user/message", { id: "n", content: [{ type: "text", text: "notice" }], source: { kind: "subagent-settled" } }),
  ]);
  expect(events).toEqual([{ kind: "user_message", input: "onetwo", inputId: "i", nativeMessageId: "i", evidence: "turn_item" }]);
});

test("native turn ends map without inventing a clean end", () => {
  expect(dshTurnOutcome({ kind: "completed" })).toEqual({ kind: "completed" });
  expect(dshTurnOutcome({ kind: "aborted", reason: { kind: "user" } })).toEqual({ kind: "aborted" });
  expect(dshTurnOutcome({ kind: "error", error: { message: "401: no", code: "AUTH", status: 401 } })).toEqual({ kind: "failed", failure: "auth", reason: "401: no", status: 401 });
  expect(dshTurnOutcome({ kind: "max-tokens" })).toMatchObject({ kind: "failed", failure: "limit_reached" });
  expect(dshTurnOutcome({ kind: "blocked" })).toMatchObject({ kind: "failed", failure: "unknown" });
  expect(dshTurnOutcome({ kind: "interrupted" })).toMatchObject({ kind: "failed", failure: "runtime_exited" });
  expect(dshTurnOutcome({ kind: "from-a-later-release" })).toEqual({ kind: "failed", failure: "unknown", reason: 'DSH ended the turn with "from-a-later-release"' });
  expect(dshTurnOutcome(null)).toMatchObject({ kind: "failed", failure: "unknown" });
});

test.each([
  ["AUTH", "auth"], ["INVALID_CREDENTIAL", "auth"], ["ACCOUNT_QUOTA", "quota"], ["QUOTA", "quota"], ["RATE_LIMIT", "rate_limited"],
  ["CONTEXT_WINDOW_EXCEEDED", "input_too_large"], ["UNKNOWN_MODEL", "model_unavailable"], ["NO_ADAPTER", "model_unavailable"],
  ["INVALID_REQUEST", "invalid_request"], ["UNSUPPORTED_REASONING_EFFORT", "invalid_request"], ["SERVER", "provider"], ["PI_AI_ERROR", "unknown"], ["UNKNOWN", "unknown"],
])("native failure code %s is %s", (code, failure) => {
  expect(dshFailureClass({ code, message: "m" })).toBe(failure);
});

test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a native code named %s is an unknown code, not an inherited property", (code) => {
  expect(dshFailureClass({ code, message: "m" })).toBe("unknown");
  expect(dshFailureClass({ code, status: 429 })).toBe("rate_limited");
  expect(dshTurnOutcome({ kind: "error", error: { code, message: "m", status: 503 } })).toEqual({ kind: "failed", failure: "overloaded", reason: "m", status: 503 });
});

test.each(["constructor", "toString", "__proto__"])("a native session id named %s starts empty", (sessionId) => {
  const { state, frames } = replay([durable("assistant/message", { usage: { inputTokens: 1, outputTokens: 1 } }, { sessionId })], "root");
  expect(frames[0]?.body.events).toEqual([{ kind: "usage", usage: { tokens: { input: 1, output: 1 } } }]);
  expect(state.sessions[sessionId]?.tokens).toEqual({ input: 1, output: 1 });
});

test("a failure without a known code falls to its reported status and never parses prose", () => {
  expect(dshFailureClass({ code: "NEW", status: 429 })).toBe("rate_limited");
  expect(dshFailureClass({ code: "PI_AI_ERROR", message: "402: pay" })).toBe("unknown");
  expect(dshFailureClass(null)).toBe("unknown");
});

// oxlint-disable-next-line eslint/max-lines-per-function -- One inline snapshot of one running total.
test("usage is native: cache parts count as input, totals run per session, an empty failed attempt reports nothing", () => {
  const { state, frames } = replay([
    durable("request/context", { provider: "p", model: "m", contextWindow: 1000 }),
    durable("assistant/message", { usage: { inputTokens: 60, outputTokens: 12, totalTokens: 112, cacheReadTokens: 40, reasoningTokens: 2 } }),
    durable("assistant/attempt", { stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }] }),
    durable("assistant/attempt", { stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } } }] }),
    durable("assistant/message", { usage: { inputTokens: 1, outputTokens: 1 } }, { sessionId: "child" }),
    durable("assistant/message", {}),
  ], "root");
  expect(frames.map((frame) => frame.body.events)).toMatchInlineSnapshot(`
    [
      [],
      [
        {
          "kind": "usage",
          "usage": {
            "context": {
              "contextWindow": 1000,
              "percent": 11,
              "tokens": 112,
            },
            "tokens": {
              "cacheRead": 40,
              "input": 100,
              "output": 12,
              "reasoning": 2,
            },
          },
        },
      ],
      [],
      [
        {
          "kind": "usage",
          "usage": {
            "tokens": {
              "cacheRead": 40,
              "input": 105,
              "output": 13,
              "reasoning": 2,
            },
          },
        },
      ],
      [
        {
          "kind": "usage",
          "usage": {
            "tokens": {
              "input": 1,
              "output": 1,
            },
          },
        },
      ],
      [],
    ]
  `);
  expect(state.sessions.child?.tokens).toEqual({ input: 1, output: 1 });
});

test("a child session's frames say whose they are; the parent's catalog is the only edge; a repeat adds none", () => {
  const { frames, state } = replay([
    native("subagent/start", { info: { runId: "run", provider: "spawn", id: "child", local: true } }),
    native("agent/status", { status: "running" }, "child"),
    durable("subagent/catalog", { version: 0, childId: "child", mode: "continuable" }),
    durable("subagent/catalog", { version: 1, childId: "child", mode: "continuable" }),
    durable("turn/end", { turn: 1, reason: { kind: "completed" } }, { sessionId: "child" }),
    native("subagent/end", { info: { runId: "run", provider: "spawn", id: "child", stopReason: "completed" } }),
    native("subagent/end", { info: { runId: "r2", stopReason: "error" } }),
    native("subagent/end", { info: { runId: "r3", stopReason: "aborted" } }),
  ], "root");
  expect(frames.map((frame) => [frame.sessionId ?? "root", frame.body.events])).toEqual([
    ["root", [{ kind: "task_started", taskId: "run", taskType: "agent", nativeType: "spawn", childSessionId: "child" }]],
    ["child", []],
    ["root", [{ kind: "session_linked", parent: "root", child: "child", via: "tool_call" }]],
    ["root", []],
    ["child", [{ kind: "turn_ended", outcome: { kind: "completed" } }]],
    ["root", [{ kind: "task_ended", taskId: "run", status: "completed" }]],
    ["root", [{ kind: "task_ended", taskId: "r2", status: "failed" }]],
    ["root", [{ kind: "task_ended", taskId: "r3", status: "stopped" }]],
  ]);
  expect(state.links).toEqual(["root child"]);
});

test.each(captures)("the captured native child of %s links from the parent's catalog", (_version, evidence) => {
  const { catalog } = evidence.child;
  const parent = catalog.sessionId;
  const { frames } = replay([catalog], parent);
  expect(frames[0]?.body.events).toEqual([{ kind: "session_linked", parent, child: catalog.event.data.childId, via: "tool_call" }]);
});

test("compaction reports come from the native log", () => {
  expect(eventsOf([durable("compaction/start", { compactionId: "c", turn: 1 }), durable("compaction/end", { compactionId: "c", turn: 1 }), durable("compaction/end", { compactionId: "d", turn: 1, error: "no room" })])).toEqual([
    { kind: "compaction_started", compactionId: "c" },
    { kind: "compaction_ended", compactionId: "c", outcome: "completed" },
    { kind: "compaction_ended", compactionId: "d", outcome: "failed", reason: "no room" },
  ]);
});

test("model and effort are read from the native request header, never from what was asked", () => {
  expect(eventsOf([durable("request/header", { header: { config: { provider: "p", model: "m", reasoningEffort: "high" } } }), durable("request/header", { header: { config: {} } })])).toEqual([
    { kind: "model", model: "p/m" },
    { kind: "effort", effort: "high" },
  ]);
  expect(dshOpenedFrame({ sessionId: "s" }).events).toEqual([]);
  expect(dshOpenedFrame({ model: { provider: "p", model: "m", reasoningEffort: "low" } }).events).toEqual([{ kind: "model", model: "p/m" }, { kind: "effort", effort: "low" }]);
});
