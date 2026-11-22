import { expect, test } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { createKapProjection, kapFailedTurn, projectKapFrame } from "../../packages/oar/src/runtimes/kimi/kap-projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

const DEFAULT_OPTS = { manualCompactionActive: false };

function frame(raw: JsonRecord): JsonRecord {
  return raw;
}

test("kapFailedTurn maps structured KAP provider auth/limit/model errors to OAR FailureClass", () => {
  expect(kapFailedTurn("error", { code: "provider.auth_error", message: "bad key", status_code: 401 })).toEqual({
    kind: "failed",
    failure: "auth",
    reason: "bad key",
    status: 401,
    credential: "rejected",
  });
  expect(kapFailedTurn("error", { code: "provider.rate_limit", message: "slow down", status_code: 429 })).toEqual({
    kind: "failed",
    failure: "rate_limited",
    reason: "slow down",
    status: 429,
  });
  expect(kapFailedTurn("error", { code: "provider.overloaded", message: "busy", status_code: 503 })).toEqual({
    kind: "failed",
    failure: "overloaded",
    reason: "busy",
    status: 503,
  });
  expect(kapFailedTurn("filtered", { code: "provider.filtered", message: "blocked" })).toEqual({
    kind: "failed",
    failure: "model_refused",
    reason: "blocked",
  });
});

test("kapFailedTurn maps overflow, model config, max_steps, and HTTP status fallbacks", () => {
  expect(kapFailedTurn("error", { code: "context.overflow", message: "too long" })).toEqual({
    kind: "failed",
    failure: "input_too_large",
    reason: "too long",
  });
  expect(kapFailedTurn("error", { code: "model.not_configured", message: "missing" })).toEqual({
    kind: "failed",
    failure: "model_unavailable",
    reason: "missing",
  });
  expect(kapFailedTurn("max_steps", { code: "loop.max_steps_exceeded", message: "max steps" })).toEqual({
    kind: "failed",
    failure: "limit_reached",
    reason: "max steps",
  });
  expect(kapFailedTurn("error", { code: "provider.api_error", message: "not found", status_code: 404 })).toEqual({
    kind: "failed",
    failure: "model_unavailable",
    reason: "not found",
    status: 404,
  });
});

test("projectKapFrame deduplicates streamed reasoning deltas against item.ended", () => {
  const state = createKapProjection("sess-1");
  const tStart = projectKapFrame(state, frame({ type: "turn.started", agent_id: "main", turn: { turn_id: "turn-1", kind: "agent", status: "running", ordinal: 0 } }), DEFAULT_OPTS);
  expect(tStart.body.events).toEqual([{ kind: "turn_active" }]);
  expect(tStart.openedTurn).toEqual({ turnId: "turn-1", agentId: "main" });

  const rStart = projectKapFrame(state, frame({ type: "item.started", agent_id: "main", turn_id: "turn-1", item: { type: "reasoning", item_id: "r-1", status: "running", text: "Think" } }), DEFAULT_OPTS);
  expect(rStart.body.events).toEqual([{ kind: "reasoning", content: { kind: "text", text: "Think" }, messageId: "r-1" }]);

  const rDelta = projectKapFrame(state, frame({ type: "item.delta", agent_id: "main", turn_id: "turn-1", item_id: "r-1", field: "text", delta: "ing..." }), DEFAULT_OPTS);
  expect(rDelta.body.events).toEqual([{ kind: "reasoning", content: { kind: "text", text: "ing..." }, messageId: "r-1" }]);

  const rEnd = projectKapFrame(state, frame({ type: "item.ended", agent_id: "main", turn_id: "turn-1", item: { type: "reasoning", item_id: "r-1", status: "ended", text: "Thinking..." } }), DEFAULT_OPTS);
  expect(rEnd.body.events).toEqual([]);
});

test("projectKapFrame emits empty reasoning marker when reasoning ends with empty text", () => {
  const state = createKapProjection("sess-1");
  projectKapFrame(state, frame({ type: "turn.started", agent_id: "main", turn: { turn_id: "turn-1", kind: "agent", status: "running", ordinal: 0 } }), DEFAULT_OPTS);
  const emptyR = projectKapFrame(state, frame({ type: "item.ended", agent_id: "main", turn_id: "turn-1", item: { type: "reasoning", item_id: "r-empty", status: "ended", text: "" } }), DEFAULT_OPTS);
  expect(emptyR.body.events).toEqual([{ kind: "reasoning", content: { kind: "empty" }, messageId: "r-empty" }]);
});

test("projectKapFrame appends only unseen suffix of assistant_message at item.ended", () => {
  const state = createKapProjection("sess-1");
  projectKapFrame(state, frame({ type: "turn.started", agent_id: "main", turn: { turn_id: "turn-1", kind: "agent", status: "running", ordinal: 0 } }), DEFAULT_OPTS);

  const aStart = projectKapFrame(state, frame({ type: "item.started", agent_id: "main", turn_id: "turn-1", item: { type: "assistant_message", item_id: "m-1", status: "running", text: "Hi" } }), DEFAULT_OPTS);
  const aDelta = projectKapFrame(state, frame({ type: "item.delta", agent_id: "main", turn_id: "turn-1", item_id: "m-1", field: "text", delta: " there" }), DEFAULT_OPTS);
  const aEnd = projectKapFrame(state, frame({ type: "item.ended", agent_id: "main", turn_id: "turn-1", item: { type: "assistant_message", item_id: "m-1", status: "ended", text: "Hi there!" } }), DEFAULT_OPTS);

  expect(aStart.body.events).toEqual([{ kind: "text_delta", text: "Hi", messageId: "m-1" }]);
  expect(aDelta.body.events).toEqual([{ kind: "text_delta", text: " there", messageId: "m-1" }]);
  expect(aEnd.body.events).toEqual([{ kind: "text_delta", text: "!", messageId: "m-1" }]);
});

test("projectKapFrame aggregates step and turn usage without double-counting and emits usage before turn_ended", () => {
  const state = createKapProjection("sess-1");
  projectKapFrame(state, frame({ type: "turn.started", agent_id: "main", turn: { turn_id: "t-1", kind: "agent", status: "running", ordinal: 0 } }), DEFAULT_OPTS);
  projectKapFrame(state, frame({ type: "item.ended", agent_id: "main", turn_id: "t-1", item: { type: "user_message", item_id: "u-1", status: "ended", text: "go", prompt_ids: ["p-1"] } }), DEFAULT_OPTS);

  const step1 = projectKapFrame(state, frame({ type: "turn.updated", agent_id: "main", turn_id: "t-1", step: { index: 1, outcome: "completed", usage: { input_other: 10, input_cache_read: 5, input_cache_creation: 2, output: 3 } } }), DEFAULT_OPTS);
  expect(step1.body.events).toEqual([{ kind: "usage", usage: { tokens: { input: 17, output: 3, cacheRead: 5, cacheWrite: 2 } } }]);

  const tEnd = projectKapFrame(state, frame({ type: "turn.ended", agent_id: "main", turn: { turn_id: "t-1", kind: "agent", status: "ended", outcome: "completed", usage: { input_other: 15, input_cache_read: 5, input_cache_creation: 2, output: 8 } } }), DEFAULT_OPTS);
  expect(tEnd.body.events).toEqual([
    { kind: "usage", usage: { tokens: { input: 22, output: 8, cacheRead: 5, cacheWrite: 2 } } },
    { kind: "turn_ended", outcome: { kind: "completed" }, inputId: "p-1" },
  ]);
});

test("projectKapFrame ignores cold-resume historical turns and system turns except compaction items", () => {
  const state = createKapProjection("sess-1");
  const coldMain = projectKapFrame(state, frame({ type: "turns", agent_id: "main", turns: [{ turn_id: "old-turn", kind: "agent", status: "ended", outcome: "completed", items: [{ type: "user_message", item_id: "old-u", status: "ended", text: "old", prompt_ids: ["old-p"] }] }] }), DEFAULT_OPTS);
  expect(coldMain.body.events).toEqual([]);

  const oldDelta = projectKapFrame(state, frame({ type: "item.delta", agent_id: "main", turn_id: "old-turn", item_id: "old-m", field: "text", delta: "stale" }), DEFAULT_OPTS);
  expect(oldDelta.body.events).toEqual([]);

  const sysStart = projectKapFrame(state, frame({ type: "turn.started", agent_id: "main", turn: { turn_id: "sys-1", kind: "system", status: "ended", outcome: "completed" } }), { manualCompactionActive: true });
  expect(sysStart.body.events).toEqual([]);

  const compEnd = projectKapFrame(state, frame({ type: "item.ended", agent_id: "main", turn_id: "sys-1", item: { type: "system", kind: "compaction", item_id: "c-1", status: "ended", outcome: "completed", trigger: "manual" } }), { manualCompactionActive: true });
  expect(compEnd.body.events).toEqual([
    { kind: "compaction_started", compactionId: "c-1", trigger: "manual" },
    { kind: "compaction_ended", compactionId: "c-1", outcome: "completed", trigger: "manual" },
  ]);
});

test("projectKapFrame projects subagent task subscription and child agentPath frames", () => {
  const state = createKapProjection("sess-1");
  const taskFrame = projectKapFrame(state, frame({ type: "task", agent_id: "main", task_id: "task-1", kind: "subagent", status: "running", detached: false, description: "subagent work", child_agent_id: "agent-child-1", parent_tool_call_id: "call-agent-1" }), DEFAULT_OPTS);
  expect(taskFrame.subscribeAgents).toEqual(["agent-child-1"]);
  expect(taskFrame.body.events).toEqual([{ kind: "task_started", taskId: "task-1", taskType: "agent", nativeType: "subagent", description: "subagent work", toolCallId: "call-agent-1", background: false }]);

  const childSnapshot = projectKapFrame(state, frame({ type: "turns", agent_id: "agent-child-1", turns: [{ turn_id: "ct-1", kind: "agent", status: "ended", outcome: "completed", items: [{ type: "assistant_message", item_id: "cm-1", status: "ended", text: "child done" }] }] }), DEFAULT_OPTS);
  expect(childSnapshot.at.agentPath).toEqual(["call-agent-1"]);
  expect(childSnapshot.body.events).toEqual([
    { kind: "turn_active" },
    { kind: "text_delta", text: "child done", messageId: "cm-1" },
    { kind: "turn_ended", outcome: { kind: "completed" } },
  ]);
});

test("projectKapFrame projects agent metadata and context usage", () => {
  const state = createKapProjection("sess-1");
  const agentFrame = projectKapFrame(state, frame({ type: "agent", agent_id: "main", model: "kimi-k2", thinking: "high" }), DEFAULT_OPTS);
  expect(agentFrame.body.events).toEqual([{ kind: "model", model: "kimi-k2" }, { kind: "effort", effort: "high" }]);

  const ctxFrame = projectKapFrame(state, frame({ type: "context", agent_id: "main", context_tokens: 500, max_context_tokens: 2000 }), DEFAULT_OPTS);
  expect(ctxFrame.body.events).toEqual([{ kind: "usage", usage: { context: { tokens: 500, contextWindow: 2000, percent: 25 } } }]);
});

test("projectKapFrame buffers pending interactions and emits app_request_cancelled when cancelled", () => {
  const state = createKapProjection("sess-1");
  const pending = projectKapFrame(state, frame({ type: "interaction", agent_id: "main", interaction_id: "int-1", kind: "approval", status: "pending", tool_call_id: "tc-1" }), DEFAULT_OPTS);
  expect(pending.skipFrame).toBe(true);
  expect(pending.pendingInteraction?.interactionId).toBe("int-1");

  const cancelled = projectKapFrame(state, frame({ type: "interaction", agent_id: "main", interaction_id: "int-1", kind: "approval", status: "ended", outcome: "cancelled" }), { manualCompactionActive: false, pendingToAppInteractions: new Set(["int-1"]) });
  expect(cancelled.endedInteractionId).toBe("int-1");
  expect(cancelled.body.events).toEqual([{ kind: "app_request_cancelled", requestId: "int-1" }]);
});

test("gates Kimi KAP vs ACP sessionCapabilities across 2.7.2-botiverse.0, 2.7.2-botiverse.1, and 2.7.3", () => {
  const unpatched = kimiRuntime.sessionCapabilities({ kind: "available", via: "executable", command: "kimi", version: "2.7.2-botiverse.0" });
  const patched = kimiRuntime.sessionCapabilities({ kind: "available", via: "executable", command: "kimi", version: "2.7.2-botiverse.1" });
  const upstream273 = kimiRuntime.sessionCapabilities({ kind: "available", via: "executable", command: "kimi", version: "2.7.3" });
  expect(unpatched).toMatchObject({ taskEventTypes: [], steer: false, stopTask: false, mcpTransports: ["stdio", "http"], manualCompaction: { kind: "unsupported" } });
  expect(unpatched.refusedSessionOptions?.appendSystemPrompt).toEqual(expect.any(String));
  expect(patched).toMatchObject({ taskEventTypes: ["agent", "shell"], steer: true, stopTask: true, mcpTransports: ["stdio", "http"], manualCompaction: { kind: "supported", activeTurn: "reject" }, compactionEvents: { started: true, ended: true } });
  expect(patched.refusedSessionOptions?.appendSystemPrompt).toBeUndefined();
  expect(upstream273).toMatchObject({ subagentResults: { foreground: "parent_tool_result" }, mcpTransports: ["stdio", "http"] });
  expect(upstream273.refusedSessionOptions?.appendSystemPrompt).toBeUndefined();
});
