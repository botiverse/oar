import { expect, test } from "vitest";
import type { RequestRecord, RuntimeEventBody } from "../packages/oar/src/contracts/session.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { turnEndAfter } from "../packages/oar/src/observe/turns.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";

function input(k: SessionKernel, id: string, options: { kind?: "prompt" | "steer" | "queue"; accepted?: boolean } = {}): RequestRecord {
  const request = k.request("toRuntime", { kind: options.kind ?? "steer", inputId: id, input: `text ${id}` });
  if (options.accepted !== false) { k.respond(request.id, { kind: "accepted" }); }
  return request;
}
function frame(k: SessionKernel, events: readonly RuntimeEventBody[]): void {
  k.frame({ type: "native", native: {}, events }, { spanId: "turn-1" });
}
function start(): SessionKernel {
  const k = createSessionKernel("thread-1");
  input(k, "prompt", { kind: "prompt" });
  frame(k, [{ kind: "user_message", inputId: "prompt", input: "text prompt", evidence: "turn_item" }]);
  frame(k, [{ kind: "tool_call_started", callId: "cmd-1", tool: "commandExecution" }]);
  return k;
}
function dropped(k: SessionKernel, inputId: string): void {
  frame(k, [{ kind: "input_dropped", inputId, reason: "turn_interrupted" }, { kind: "turn_ended", outcome: { kind: "aborted" } }]);
}

test("an interrupted Codex steer leaves the pending tray where its drop is recorded", () => {
  const k = start();
  const request = input(k, "steer");
  dropped(k, "steer");
  const view = viewOf(k.records());
  expect(view.pendingInputs).toEqual([]);
  expect(view.messages.map((message) => message.kind)).toEqual(["input", "turn", "input", "turn"]);
  expect(view.messages[2]).toMatchObject({ kind: "input", input: { inputId: "steer", state: "dropped", reason: "turn_interrupted", attempts: [{ request, state: "accepted" }] } });
  expect(view.messages.at(-1)).toMatchObject({ outcome: { kind: "aborted" } });
});

test.each(["completed", "aborted"] as const)("a %s turn alone never drops unread input", (kind) => {
  const k = start();
  input(k, "still-owned");
  frame(k, [{ kind: "turn_ended", outcome: { kind } }]);
  expect(viewOf(k.records()).pendingInputs).toMatchObject([{ state: "accepted", inputId: "still-owned" }]);
});

test("exit drops accepted and unanswered inputs without rewriting control facts", () => {
  const k = start();
  input(k, "steer");
  input(k, "held", { kind: "queue" });
  const unanswered = input(k, "unanswered", { accepted: false });
  k.respond("", { kind: "exited", code: 9 });
  k.respond(unanswered.id, { kind: "accepted" });
  const view = viewOf(k.records());
  expect(view.pendingInputs).toEqual([]);
  expect([...view.conversation.inputs.values()].slice(1).map((entry) => [entry.inputId, entry.state, entry.reason])).toEqual([
    ["steer", "dropped", "runtime_exited"], ["held", "dropped", "runtime_exited"], ["unanswered", "dropped", "runtime_exited"],
  ]);
});

test("child exit does not drop root input", () => {
  const k = start();
  input(k, "root");
  k.respond("", { kind: "exited", code: 1 }, { agentPath: ["child"] });
  expect(viewOf(k.records()).pendingInputs).toMatchObject([{ inputId: "root", state: "accepted" }]);
});

test("streams that place inputs at the request have nothing waiting for exit to drop", () => {
  const k = createSessionKernel("no-echo");
  input(k, "steer");
  k.respond("", { kind: "exited", code: 1 });
  expect([...conversationOf(k.records()).inputs.values()][0]).toMatchObject({ inputId: "steer", state: "accepted" });
});

test("retrying a dropped input ignores old accepted attempts and clears its drop reason", () => {
  const k = start();
  input(k, "retry");
  dropped(k, "retry");
  const request = input(k, "retry", { accepted: false });
  expect(viewOf(k.records()).pendingInputs).toMatchObject([{ inputId: "retry", state: "pending" }]);
  k.respond(request.id, { kind: "rejected", code: "no_active_turn", reason: "idle" });
  const retried = [...conversationOf(k.records()).inputs.values()].find((entry) => entry.inputId === "retry");
  expect(retried).toMatchObject({ state: "rejected", attempts: [{ state: "accepted" }, { state: "rejected" }] });
  expect(retried).not.toHaveProperty("reason");
});

test("native drop stays distinct from acceptance and already observed input", () => {
  const k = start();
  input(k, "read");
  frame(k, [{ kind: "user_message", inputId: "read", input: "text read", evidence: "turn_item" }]);
  input(k, "unread");
  dropped(k, "unread");
  expect([...conversationOf(k.records()).inputs.values()].map((entry) => [entry.inputId, entry.state])).toEqual([
    ["prompt", "accepted"], ["read", "accepted"], ["unread", "dropped"],
  ]);
});


test.each([
  { detail: {}, failure: "unknown", reason: "runtime refused the input" },
  { detail: { failure: "invalid_request", message: "native refusal" }, failure: "invalid_request", reason: "native refusal" },
] as const)("an input-scoped refusal uses contract details or unknown without ending the turn: $failure", ({ detail, failure, reason }) => {
  const k = createSessionKernel("root");
  const request = input(k, "owned", { kind: "prompt" });
  frame(k, [{ kind: "input_dropped", inputId: "other", reason: "runtime_refused", ...detail }]);
  expect(turnEndAfter(k.records(), request.seq, "root", "owned")).toBeNull();
  frame(k, [{ kind: "input_dropped", inputId: "owned", reason: "runtime_refused", ...detail }]);
  expect(turnEndAfter(k.records(), request.seq, "root", "owned")).toEqual({ kind: "failed", failure, reason });
  expect(turnEndAfter(k.records(), request.seq, "root")).toBeNull();
});
