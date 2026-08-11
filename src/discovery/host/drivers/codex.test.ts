import assert from "node:assert/strict";
import test from "node:test";
import { optionsBranch } from "../../../config/model.js";
import type { RuntimeEvent } from "../../../events/event.js";
import {
  CODEX_USER_CONFIGURED,
  codexNormalise,
  parseCodexModelsCache,
} from "./codex.js";

test("cache with only non-list visibility yields user-configured", () => {
  const { models, hadNonList } = parseCodexModelsCache({
    models: [
      { slug: "secret-model", display_name: "Secret", visibility: "hidden" },
    ],
  });
  assert.equal(hadNonList, true);
  assert.ok(models.some((m) => m.id === "user-configured"));
  assert.equal(models.find((m) => m.id === "secret-model"), undefined);
});

test("cache with list models appends user-configured", () => {
  const { models } = parseCodexModelsCache({
    models: [
      {
        slug: "gpt-5",
        display_name: "GPT-5",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
    ],
  });
  assert.equal(models[0]?.id, "gpt-5");
  assert.ok(models.some((m) => m.id === "user-configured"));
});

test("empty models array still emits user-configured (not bare [])", () => {
  const { models } = parseCodexModelsCache({ models: [] });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "user-configured");
});

test("user-configured has zero options (supported⇒required invariant)", () => {
  assert.equal(CODEX_USER_CONFIGURED.options.length, 0);
  const branch = optionsBranch(CODEX_USER_CONFIGURED.options);
  assert.equal(branch.required.length, 0);
  assert.deepEqual(branch.properties, {});
});

test("user-configured options must not invent caps (tooth c)", () => {
  // Mutation guard: if someone later stuffs a default option onto the sentinel,
  // supported⇒required would make create-form force-fill it — that must fail.
  assert.equal(CODEX_USER_CONFIGURED.options.length, 0);
});

// --- Turn protocol: normalise(frame) → RuntimeEvent[] ----------------------
//
// Frame shapes are the ones raft's production daemon codex driver reads
// (packages/daemon/src/drivers/codexEventNormalizer.ts) and drives in its
// integration test (codex.integration.test.ts). See codex.ts `codexNormalise`
// for the per-line raft citations.

function normSeq(frames: readonly unknown[]): RuntimeEvent[] {
  return frames.flatMap((f) => [...codexNormalise(f)]);
}

test("codex normalise: a full turn maps to tool_call/tool_result/text/turn_end", () => {
  // Sequence captured from a shell-then-answer turn (raft codex.test.ts:1687-1695
  // for the commandExecution item; :1151-1162 for the completed agentMessage;
  // integration test :263-269 for turn/started + turn/completed).
  const events = normSeq([
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    { jsonrpc: "2.0", id: 3, result: { turn: { id: "turn-1" } } }, // turn/start accepted
    { method: "item/started", params: { item: { id: "tool-1", type: "commandExecution", command: "ls" } } },
    { method: "item/completed", params: { item: { id: "tool-1", type: "commandExecution", command: "ls" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "item-1", delta: "Hi" } },
    { method: "item/completed", params: { item: { type: "agentMessage", id: "item-1", text: "Hi there" } } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
  ]);

  assert.deepEqual(events, [
    { kind: "tool_call", callId: "tool-1", name: "shell" },
    { kind: "tool_result", callId: "tool-1", ok: true },
    { kind: "text", text: "Hi there" },
    { kind: "turn_end", reason: "completed" },
  ]);
});

test("codex normalise: mcpToolCall maps to a namespaced tool name", () => {
  assert.deepEqual(
    [...codexNormalise({
      method: "item/started",
      params: { item: { id: "mcp-1", type: "mcpToolCall", server: "fs", tool: "read" } },
    })],
    [{ kind: "tool_call", callId: "mcp-1", name: "mcp_fs_read" }],
  );
});

test("codex normalise: commentary-phase completed agent text is NOT user-visible", () => {
  // Negative control: the ONLY difference from the surfaced case is item.phase.
  assert.deepEqual(
    [...codexNormalise({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "item-1", phase: "commentary", text: "scaffolding" } },
    })],
    [],
  );
  // final_answer phase IS surfaced (proves the gate can go both ways).
  assert.deepEqual(
    [...codexNormalise({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "item-1", phase: "final_answer", text: "answer" } },
    })],
    [{ kind: "text", text: "answer" }],
  );
});

test("codex normalise: agentMessage deltas are tolerated (text arrives at completion)", () => {
  assert.deepEqual(
    [...codexNormalise({ method: "item/agentMessage/delta", params: { itemId: "item-1", delta: "Hi" } })],
    [],
  );
});

test("codex normalise: turn/completed status=failed → runtime_error + turn_end(crashed)", () => {
  const events = [...codexNormalise({
    method: "turn/completed",
    params: { turn: { id: "turn-1", status: "failed", error: { message: "boom" } } },
  })];
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "runtime_error");
  assert.equal(events[0]?.kind === "runtime_error" ? events[0].detail.detail : null, "boom");
  assert.deepEqual(events[1], { kind: "turn_end", reason: "crashed" });
});

test("codex normalise: turn/completed status=interrupted → turn_end(interrupted)", () => {
  assert.deepEqual(
    [...codexNormalise({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } } })],
    [{ kind: "turn_end", reason: "interrupted" }],
  );
});

test("codex normalise: JSON-RPC error response → runtime_error", () => {
  const events = [...codexNormalise({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "thread not found" } })];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "runtime_error");
  assert.equal(events[0]?.kind === "runtime_error" ? events[0].detail.detail : null, "thread not found");
});

test("codex normalise: error notification willRetry=true is tolerated; terminal error surfaces", () => {
  assert.deepEqual(
    [...codexNormalise({ method: "error", params: { willRetry: true, message: "transient" } })],
    [],
  );
  const terminal = [...codexNormalise({ method: "error", params: { message: "fatal" } })];
  assert.equal(terminal[0]?.kind, "runtime_error");
});

test("codex normalise: JSON-RPC success responses and unknown frames tolerate to []", () => {
  assert.deepEqual([...codexNormalise({ jsonrpc: "2.0", id: 1, result: { thread: { id: "thread-1" } } })], []);
  assert.deepEqual([...codexNormalise({ method: "thread/tokenUsage/updated", params: { tokenUsage: {} } })], []);
  assert.deepEqual([...codexNormalise({ method: "turn/started", params: { turn: { id: "turn-1" } } })], []);
  assert.deepEqual([...codexNormalise("not-json-object")], []);
  assert.deepEqual([...codexNormalise(null)], []);
});

test("codex normalise: tool item without an id cannot form a call envelope", () => {
  // Negative: item.id is the callId source; without it there is no clean call.
  assert.deepEqual(
    [...codexNormalise({ method: "item/started", params: { item: { type: "commandExecution", command: "ls" } } })],
    [],
  );
});
