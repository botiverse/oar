import assert from "node:assert/strict";
import test from "node:test";
import { optionsBranch } from "../../../config/model.js";
import type { RuntimeEvent } from "../../../events/event.js";
import {
  buildClaudeModels,
  claudeNormalise,
  defaultClaudeModelIds,
} from "./claude.js";

// --- Catalog (pre-existing behavior; kept green while wiring the turn protocol) ---

test("claude catalog: aliases + api models + user-configured escape", () => {
  const models = buildClaudeModels();
  assert.ok(models.some((m) => m.id === "sonnet"));
  assert.ok(models.some((m) => m.id === "claude-opus-5"));
  const uc = models.find((m) => m.id === "user-configured");
  assert.ok(uc, "user-configured escape present");
  // supported⇒required invariant: zero options ⇒ zero required.
  const branch = optionsBranch(uc.options);
  assert.equal(branch.required.length, 0);
});

test("claude catalog: CLAUDE_MODEL_LIST-style extra ids extend the set", () => {
  const models = buildClaudeModels(["claude-3-5-haiku-latest"]);
  assert.ok(models.some((m) => m.id === "claude-3-5-haiku-latest"));
  assert.ok(defaultClaudeModelIds().includes("sonnet"));
});

// --- Turn protocol: claudeNormalise(frame) → RuntimeEvent[] -------------------
//
// Frame shapes are the ones raft's production daemon claude driver reads
// (packages/daemon/src/drivers/claudeEventNormalizer.ts) and drives in its
// integration test (claude.integration.test.ts). See claude.ts `claudeNormalise`
// for the per-line raft citations.

function normSeq(frames: readonly unknown[]): RuntimeEvent[] {
  return frames.flatMap((f) => [...claudeNormalise(f)]);
}

test("claude normalise: a full turn maps to tool_call/tool_result/text/turn_end+usage", () => {
  // Sequence captured from a tool-then-answer turn: assistant tool_use, user
  // tool_result, assistant final text, result. (raft claudeEventNormalizer.ts
  // :332-334 tool_use; :346-347 tool_result; :326-331 text; :354-390 result.)
  const events = normSeq([
    { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-5" }, // readiness/init — dropped
    { type: "stream_event", event: { type: "message_start" } }, // partial-stream — dropped
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }] },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 },
    },
  ]);

  assert.deepEqual(events, [
    { kind: "tool_call", callId: "toolu_1", name: "Bash" },
    { kind: "tool_result", callId: "toolu_1", ok: true },
    { kind: "text", text: "Hi there" },
    {
      kind: "turn_end",
      reason: "completed",
      usage: { scope: "turn", usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 } },
    },
  ]);
});

test("claude normalise: tool_result is_error toggles ok BOTH ways (negative control)", () => {
  // The ONLY difference between these two frames is block.is_error.
  assert.deepEqual(
    [...claudeNormalise({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
    })],
    [{ kind: "tool_result", callId: "t1", ok: false }],
  );
  assert.deepEqual(
    [...claudeNormalise({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
    })],
    [{ kind: "tool_result", callId: "t1", ok: true }],
  );
});

test("claude normalise: tool_result without tool_use_id cannot form a call envelope", () => {
  assert.deepEqual(
    [...claudeNormalise({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
    })],
    [],
  );
});

test("claude normalise: assistant API-failure text → runtime_error, ordinary text → text (both directions)", () => {
  // Fires: API Error with a 5xx and no tool_use in the message.
  const failure = [...claudeNormalise({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 overloaded" }] },
  })];
  assert.equal(failure.length, 1);
  assert.equal(failure[0]?.kind, "runtime_error");
  assert.equal(failure[0]?.kind === "runtime_error" ? failure[0].detail.detail : null, "API Error: 529 overloaded");

  // Does NOT fire: same leading text but a tool_use is present in the message.
  assert.deepEqual(
    [...claudeNormalise({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "API Error: 529 overloaded" },
          { type: "tool_use", id: "tu1", name: "Bash", input: {} },
        ],
      },
    })],
    [
      { kind: "text", text: "API Error: 529 overloaded" },
      { kind: "tool_call", callId: "tu1", name: "Bash" },
    ],
  );
});

test("claude normalise: thinking blocks are tolerated (no oar thinking kind)", () => {
  assert.deepEqual(
    [...claudeNormalise({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    })],
    [],
  );
});

test("claude normalise: tool_use without id cannot form a call envelope", () => {
  assert.deepEqual(
    [...claudeNormalise({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
    })],
    [],
  );
});

test("claude normalise: result error subtypes fold to runtime_error + turn_end(crashed)", () => {
  const budget = [...claudeNormalise({ type: "result", subtype: "error_max_budget_usd" })];
  assert.equal(budget[0]?.kind, "runtime_error");
  assert.equal(budget[0]?.kind === "runtime_error" ? budget[0].detail.detail : null, "Budget limit exceeded");
  assert.deepEqual(budget[1], { kind: "turn_end", reason: "crashed" });

  const turns = [...claudeNormalise({ type: "result", subtype: "error_max_turns", errors: ["hit the wall"] })];
  assert.equal(turns[0]?.kind === "runtime_error" ? turns[0].detail.detail : null, "hit the wall");
  assert.deepEqual(turns[1], { kind: "turn_end", reason: "crashed" });
});

test("claude normalise: result success with is_error → runtime_error + turn_end(crashed)", () => {
  const events = [...claudeNormalise({ type: "result", subtype: "success", is_error: true, result: "boom" })];
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind === "runtime_error" ? events[0].detail.detail : null, "boom");
  assert.deepEqual(events[1], { kind: "turn_end", reason: "crashed" });
});

test("claude normalise: plain success result → turn_end(completed) with no error", () => {
  assert.deepEqual(
    [...claudeNormalise({ type: "result", subtype: "success" })],
    [{ kind: "turn_end", reason: "completed" }],
  );
});

test("claude normalise: usage absence is preserved (no hollow zero report)", () => {
  // A result with an empty usage object must NOT manufacture a usage report.
  const events = [...claudeNormalise({ type: "result", subtype: "success", usage: {} })];
  assert.deepEqual(events, [{ kind: "turn_end", reason: "completed" }]);
});

test("claude normalise: unknown / partial-stream / init / rate-limit frames tolerate to []", () => {
  assert.deepEqual([...claudeNormalise({ type: "system", subtype: "init", session_id: "s" })], []);
  assert.deepEqual([...claudeNormalise({ type: "system", subtype: "compact_boundary" })], []);
  assert.deepEqual([...claudeNormalise({ type: "stream_event", event: { type: "content_block_delta" } })], []);
  assert.deepEqual([...claudeNormalise({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })], []);
  assert.deepEqual([...claudeNormalise("not-json-object")], []);
  assert.deepEqual([...claudeNormalise(null)], []);
});
