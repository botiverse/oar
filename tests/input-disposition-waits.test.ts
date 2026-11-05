/* oxlint-disable max-statements -- Exercise retained and live waits through each complete record sequence. */
import { expect, test } from "vitest";
import { createSessionKernel, sealSession } from "../packages/oar/src/kernel.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { awaitIdle, awaitTurnEnd, turnEndAfter } from "../packages/oar/src/observe/turns.js";

const inputId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const kernel = createSessionKernel("root");
  const session = sealSession({ id: "root", capabilities: { queue: { durable: false }, attribution: "none", images: false },
    prompt: async (input, options) => kernel.control({ kind: "prompt", input, ...options }, () => ({ kind: "accepted" })),
    queue: async (input, options) => kernel.control({ kind: "queue", input, ...options }, () => ({ kind: "accepted", queued: "adapter" })),
    abort: async () => kernel.control({ kind: "abort" }, () => ({ kind: "accepted" })),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor), records: () => kernel.records(), graph: () => kernel.graph(), dispose: async () => {},
  });
  return { kernel, session };
}

test("awaitIdle finishes when the last queued input is natively refused", async () => {
  const { kernel, session } = fixture();
  const first = kernel.request("toRuntime", { kind: "prompt", input: "A" });
  kernel.respond(first.id, { kind: "accepted" });
  kernel.frame({ type: "start", native: {}, events: [{ kind: "turn_active" }] });
  const queued = kernel.request("toRuntime", { kind: "queue", input: "B", inputId });
  kernel.respond(queued.id, { kind: "accepted", queued: "adapter" });
  const idle = awaitIdle(session);
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  const dispatch = kernel.request("toRuntime", { kind: "prompt", input: "B", carries: [inputId], admission: "native" });
  kernel.frame({ type: "refused", native: {}, events: [{ kind: "input_dropped", requestId: dispatch.id, reason: "runtime_refused", message: "native refused B" }] });
  kernel.respond(dispatch.id, { kind: "rejected", code: "runtime_refused", reason: "native refused B" });
  expect(session.status().value.kind).toBe("idle");
  await expect(idle).resolves.toMatchObject({ kind: "failed", reason: "native refused B" });
});

test("a rejected invalid carry claim cannot finish the original held input's wait", async () => {
  const { kernel, session } = fixture();
  const queue = kernel.request("toRuntime", { kind: "queue", input: "B", inputId });
  kernel.respond(queue.id, { kind: "accepted", queued: "adapter" });
  const waiting = awaitTurnEnd(session, queue.seq, inputId);
  const claim = kernel.request("toRuntime", { kind: "prompt", input: "invalid", carries: [inputId, "unknown"] });
  kernel.respond(claim.id, { kind: "rejected", code: "unsupported", reason: "unknown carried input" });
  expect(turnEndAfter(kernel.records(), queue.seq, session.id, inputId)).toBeNull();
  expect(session.status().value.kind).toBe("running");
  const withdrawal = kernel.request("toRuntime", { kind: "withdraw", inputId });
  kernel.respond(withdrawal.id, { kind: "accepted" });
  await expect(waiting).resolves.toEqual({ kind: "aborted" });
});

test.each(["withdraw", "dispatch"] as const)("adapter-held scoped waits finish after %s even without a native drop", async action => {
  const { kernel, session } = fixture();
  const queue = kernel.request("toRuntime", { kind: "queue", input: "B", inputId });
  kernel.respond(queue.id, { kind: "accepted", queued: "adapter" });
  const waiting = awaitTurnEnd(session, queue.seq, inputId);
  if (action === "withdraw") {
    const withdrawal = kernel.request("toRuntime", { kind: "withdraw", inputId });
    kernel.respond(withdrawal.id, { kind: "accepted" });
  } else {
    const dispatch = kernel.request("toRuntime", { kind: "prompt", input: "B", carries: [inputId] });
    kernel.respond(dispatch.id, { kind: "rejected", code: "runtime_exited", reason: "runtime exited before dispatch" });
  }
  const expected = action === "withdraw" ? { kind: "aborted" } : { kind: "failed", failure: "unknown", reason: "runtime exited before dispatch" };
  expect(turnEndAfter(kernel.records(), queue.seq, session.id, inputId)).toEqual(expected);
  await expect(waiting).resolves.toEqual(expected);
});

test("a cursor after an input drop binds the next retry, not the already settled attempt", async () => {
  const { kernel, session } = fixture();
  const old = kernel.request("toRuntime", { kind: "prompt", input: "old", inputId, admission: "native" });
  kernel.frame({ type: "dropped", native: {}, events: [{ kind: "input_dropped", requestId: old.id, inputId, reason: "runtime_refused" }] });
  const cursor = kernel.respond(old.id, { kind: "accepted" }).seq;
  const waiting = awaitTurnEnd(session, cursor, inputId);
  const retry = kernel.request("toRuntime", { kind: "prompt", input: "retry", inputId, admission: "native" });
  const receipt = kernel.frame({ type: "handled", native: {}, events: [{ kind: "input_handled", requestId: retry.id, inputId }] });
  kernel.respond(retry.id, { kind: "accepted" });
  const expected = { kind: "handled", requestId: retry.id, inputId, seq: receipt.seq };
  expect(turnEndAfter(kernel.records(), cursor, session.id, inputId)).toEqual(expected);
  expect(await waiting).toEqual(expected);
});

test.each([false, true])("legacy input drop keeps delivery state and updates, tracked=%s", tracked => {
  const { kernel } = fixture();
  if (tracked) {
    const request = kernel.request("toRuntime", { kind: "prompt", input: "tracked", inputId });
    kernel.respond(request.id, { kind: "accepted" });
  } else {
    kernel.frame({ type: "message", native: {}, events: [{ kind: "user_message", input: "external", inputId, evidence: "turn_item" }] });
  }
  kernel.frame({ type: "drop", native: {}, events: [{ kind: "input_dropped", inputId, reason: "turn_interrupted" }] });
  const state = conversationOf(kernel.records());
  expect([...state.inputs.values()][0]).toMatchObject({ state: "dropped", reason: "turn_interrupted" });
  expect(state.updates.map(update => update.kind)).toEqual(["input"]);
});
