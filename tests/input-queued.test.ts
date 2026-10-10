import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { reduceStatus, statusOf } from "../packages/oar/src/observe/agent-status.js";
import { conversationOf, reduceConversation } from "../packages/oar/src/observe/conversation.js";
import { reduceSessionView, viewOf } from "../packages/oar/src/observe/session-view.js";
import { turnEndAfter } from "../packages/oar/src/observe/turns.js";
import type { RuntimeEventBody } from "../packages/oar/src/contracts/session.js";

const frame = (kernel: ReturnType<typeof createSessionKernel>, ...events: RuntimeEventBody[]) => kernel.frame({ type: "native", native: {}, events });

// oxlint-disable-next-line max-statements -- Follow two distinct results through the retained prefix and a checkpoint.
test("queue evidence survives unrelated turns, serialization and a cursor inside the notification", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "own", inputId: "own" });
  kernel.respond(request.id, { kind: "accepted" });
  const queued = frame(kernel, { kind: "input_queued", inputId: "own" });
  const beforeCheckpoint = statusOf(kernel.records(), "root").value;
  const serialized = JSON.stringify(beforeCheckpoint);
  const checkpoint: unknown = JSON.parse(serialized);
  assert.deepEqual(checkpoint, beforeCheckpoint);
  expect(checkpoint).toMatchObject({ kind: "idle", pendingPrompt: { inputId: "own", requestId: request.id } });
  frame(kernel, { kind: "turn_active" }, { kind: "text_delta", text: "notice" });
  frame(kernel, { kind: "turn_ended", outcome: { kind: "failed", reason: "notice failed", failure: "unknown" } });
  expect(turnEndAfter(kernel.records(), request.seq, "root")).toMatchObject({ kind: "failed" });
  expect(turnEndAfter(kernel.records(), queued.seq, "root", "own")).toBeNull();
  expect(viewOf(kernel.records()).pendingInputs.map((input) => input.inputId)).toEqual(["own"]);
  frame(kernel, { kind: "turn_active", inputId: "own" });
  frame(kernel, { kind: "text_delta", text: "answer" });
  frame(kernel, { kind: "turn_ended", outcome: { kind: "completed" } });
  expect(turnEndAfter(kernel.records(), queued.seq, "root", "own")).toEqual({ kind: "completed" });
  const rest = kernel.records().filter((record) => record.seq > queued.seq);
  expect(rest.reduce((state, record) => reduceStatus(state, record, "root"), checkpoint)).toEqual(statusOf(kernel.records(), "root").value);
  expect([...conversationOf(kernel.records()).inputs.values()][0]).toMatchObject({ state: "accepted", turn: { state: "active" } });
  const view = viewOf(kernel.records());
  expect(view.messages.map((message) => message.kind)).toEqual(["turn", "input", "turn"]);
  expect(view.messages[0]).not.toHaveProperty("openedBy");
  expect(view.messages[2]).toMatchObject({ openedBy: request.id });
});

test("a child's queue and start cannot change the root prompt's attribution", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "own", inputId: "own" });
  kernel.respond(request.id, { kind: "accepted" });
  frame(kernel, { kind: "input_queued", inputId: "own" });
  kernel.frame({ type: "child", native: {}, events: [{ kind: "turn_active", inputId: "own" }, { kind: "turn_ended", outcome: { kind: "completed" } }] }, { agentPath: ["child"] });
  expect(statusOf(kernel.records(), "root").value).toMatchObject({ kind: "idle", pendingPrompt: { inputId: "own" } });
  expect(turnEndAfter(kernel.records(), request.seq, "root", "own")).toBeNull();
  expect(viewOf(kernel.records()).pendingInputs).toHaveLength(1);
});

test.each([false, true])("an exit releases a queued wait even before its native start: dispose=%s", (dispose) => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "own", inputId: "own" });
  frame(kernel, { kind: "input_queued", inputId: "own" });
  if (dispose) { kernel.request("toRuntime", { kind: "dispose" }); }
  kernel.respond("", { kind: "exited", code: 1 });
  expect(turnEndAfter(kernel.records(), request.seq, "root", "own")).toMatchObject({ kind: dispose ? "aborted" : "failed" });
  expect(statusOf(kernel.records(), "root").value.pendingPrompt).toBeUndefined();
});

test("an abort requested before queue evidence remains correlated after it", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "own", inputId: "own" });
  const abort = kernel.request("toRuntime", { kind: "abort" });
  frame(kernel, { kind: "input_queued", inputId: "own" });
  kernel.respond(abort.id, { kind: "accepted" });
  kernel.respond("", { kind: "exited", code: 1 });
  expect(turnEndAfter(kernel.records(), request.seq, "root", "own")).toEqual({ kind: "aborted" });
});

// oxlint-disable-next-line max-statements -- Follow the same input through exit and a new stream's replay.
test("a resumed echo can restore an input without reviving its exited queue", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "own", inputId: "own" });
  kernel.respond(request.id, { kind: "accepted" });
  frame(kernel, { kind: "input_queued", inputId: "own" });
  kernel.respond("", { kind: "exited", code: 1 });
  const view = viewOf(kernel.records(), "first");
  expect(view.pendingInputs).toHaveLength(0);
  expect([...view.conversation.inputs.values()][0]).toMatchObject({ state: "dropped", reason: "runtime_exited" });
  const resumed = createSessionKernel("root");
  const echo = frame(resumed, { kind: "user_message", inputId: "own", input: "own", evidence: "acknowledged" });
  const restored = reduceSessionView(view, echo, "resumed");
  expect(restored.pendingInputs).toHaveLength(0);
  expect([...restored.conversation.inputs.values()][0]).toMatchObject({ state: "accepted" });
  expect(restored.conversation).toEqual(reduceConversation(view.conversation, echo, "resumed"));
});
