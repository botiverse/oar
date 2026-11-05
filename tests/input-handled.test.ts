/* oxlint-disable max-statements -- Each case checks all public folds at the same native boundary. */
import { expect, expectTypeOf, test } from "vitest";
import type { RawEvent, RequestRecord, TurnOutcome } from "../packages/oar/src/contracts/session.js";
import { createSessionKernel, sealSession } from "../packages/oar/src/kernel.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { awaitsEcho } from "../packages/oar/src/observe/input-delivery.js";
import { initialStatus, reduceStatus, statusOf, statusValue, type StatusState } from "../packages/oar/src/observe/agent-status.js";
import { initialSessionView, reduceSessionView, viewOf } from "../packages/oar/src/observe/session-view.js";
import { initialTaskState, reduceTaskState } from "../packages/oar/src/observe/tasks.js";
import { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter, type InputHandled } from "../packages/oar/src/observe/turns.js";

const inputId = "11111111-1111-4111-8111-111111111111";
const handled = (request: RequestRecord) => ({ kind: "input_handled" as const, requestId: request.id,
  ...("inputId" in request.body ? { inputId: request.body.inputId } : {}) });

function assertCheckpoints(records: readonly RawEvent[]): void {
  let state = initialStatus;
  let view = initialSessionView();
  let tasks = initialTaskState("root");
  for (const record of records) {
    // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- Exercise persisted public checkpoints.
    const restored: StatusState = JSON.parse(JSON.stringify(state));
    state = reduceStatus(restored, record, "root");
    view = reduceSessionView(view, record);
    tasks = reduceTaskState({ ...tasks, status: structuredClone(tasks.status) }, record);
    const prefix = records.filter(item => item.seq <= record.seq);
    expect(statusValue(state)).toEqual(statusOf(prefix, "root").value);
    expect(view.status).toEqual(statusValue(state));
    expect(tasks.status).toEqual(state);
    expect(view).toEqual(viewOf(prefix));
  }
}

test.each([false, true])("handled without inputId=%s resolves only that attempt and invents no turn", noId => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "handled", ...(noId ? {} : { inputId }) });
  const evidence = kernel.frame({ type: "receipt", native: { disposition: "handled" }, events: [handled(request)] });
  kernel.respond(request.id, { kind: "accepted" });
  expect(statusOf(kernel.records()).value).toEqual({ kind: "idle" });
  const conversation = conversationOf(kernel.records());
  const [input] = [...conversation.inputs.values()];
  expect(input).toMatchObject({ state: "accepted", disposition: { kind: "handled", requestId: request.id, seq: evidence.seq } });
  if (input === undefined) { throw new Error("missing input"); }
  expect(awaitsEcho(input, conversation)).toBe(false);
  expect(input.attempts[0]?.disposition).toEqual(input.disposition);
  expect(viewOf(kernel.records()).messages.map(message => message.kind)).toEqual(["input"]);
  expect(turnEndAfter(kernel.records(), request.seq)).toBeNull();
  assertCheckpoints(kernel.records());
});

test.each(["before", "after"] as const)("independent native activity %s handling keeps its phase and loses provisional attribution", order => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "/spawn", inputId });
  const receipt = () => kernel.frame({ type: "receipt", native: "handled", events: [handled(request)] });
  if (order === "before") { receipt(); }
  const start = kernel.frame({ type: "start", native: {}, events: [{ kind: "turn_active" }] });
  kernel.frame({ type: "text", native: {}, events: [{ kind: "text_delta", text: "independent" }] });
  if (order === "after") { receipt(); }
  kernel.respond(request.id, { kind: "accepted" });
  const status = statusOf(kernel.records()).value;
  expect(status).toMatchObject({ kind: "running", phase: "responding", sinceSeq: start.seq });
  expect(status).not.toHaveProperty("requestId"); expect(status).not.toHaveProperty("inputId");
  const turn = viewOf(kernel.records()).messages.find(message => message.kind === "turn");
  expect(turn).not.toHaveProperty("openedBy");
  expect(JSON.stringify(turn)).toContain("independent");
  assertCheckpoints(kernel.records());
});

test.each(["handled", "refused"] as const)("an adapter-held input %s before dispatch acceptance removes its reservation and keeps one bubble", disposition => {
  const kernel = createSessionKernel("root");
  const queue = kernel.request("toRuntime", { kind: "queue", input: "held" });
  kernel.respond(queue.id, { kind: "accepted", queued: "adapter" });
  const dispatch = kernel.request("toRuntime", { kind: "prompt", input: "held", carries: [queue.id] });
  kernel.frame({ type: "response", native: disposition, events: [disposition === "handled" ? handled(dispatch)
    : { kind: "input_dropped", requestId: dispatch.id, reason: "runtime_refused", message: "native refusal" }] });
  kernel.respond(dispatch.id, disposition === "handled" ? { kind: "accepted" } : { kind: "rejected", code: "runtime_refused", reason: "native refusal" });
  expect(statusOf(kernel.records()).value).toEqual({ kind: "idle" });
  const view = viewOf(kernel.records());
  expect(view.messages.map(message => message.kind)).toEqual(["input"]);
  const [first] = view.messages;
  expect(first?.kind === "input" ? first.input.state : null).toBe(disposition === "handled" ? "accepted" : "dropped");
  assertCheckpoints(kernel.records());
});

test("late and foreign handling cannot dispose a newer attempt with the same logical inputId", () => {
  const kernel = createSessionKernel("root");
  const first = kernel.request("toRuntime", { kind: "prompt", input: "old", inputId });
  kernel.frame({ type: "handled", native: "handled", events: [handled(first)] });
  kernel.respond(first.id, { kind: "accepted" });
  const second = kernel.request("toRuntime", { kind: "prompt", input: "new", inputId });
  kernel.respond(second.id, { kind: "accepted" });
  for (const at of [{}, { agentPath: ["child"] }, { sessionId: "foreign" }]) {
    kernel.frame({ type: "late", native: "handled", events: [handled(at.agentPath === undefined && at.sessionId === undefined ? first : second)] }, at);
  }
  expect(statusOf(kernel.records(), "root").value).toMatchObject({ kind: "running", requestId: second.id });
  const current = [...conversationOf(kernel.records()).inputs.values()].find(input => input.inputId === inputId);
  expect(current).not.toHaveProperty("disposition"); expect(current?.attempts[0]?.disposition?.kind).toBe("handled");
  expect(turnEndAfter(kernel.records(), second.seq, "root", inputId)).toBeNull();
  kernel.frame({ type: "handled", native: "handled", events: [handled(second)] });
  expect(turnEndAfter(kernel.records(), second.seq, "root", inputId)).toMatchObject({ kind: "handled", requestId: second.id });
  assertCheckpoints(kernel.records());
});

test("legacy logs without handling evidence keep the provisional reservation", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "legacy", inputId });
  kernel.frame({ type: "response", native: { disposition: "handled" }, events: [] });
  kernel.respond(request.id, { kind: "accepted" });
  expect(statusOf(kernel.records()).value).toMatchObject({ kind: "running", requestId: request.id });
  expect(turnEndAfter(kernel.records(), request.seq, "root", inputId)).toBeNull();
  assertCheckpoints(kernel.records());
});

test("unmarked legacy prompts keep their rejection and first-end interpretation", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "legacy", inputId });
  kernel.frame({ type: "start", native: {}, events: [{ kind: "turn_active" }] });
  kernel.respond(request.id, { kind: "rejected", code: "runtime_refused", reason: "legacy refusal" });
  expect(statusOf(kernel.records()).value).toEqual({ kind: "idle" });
  const next = kernel.request("toRuntime", { kind: "prompt", input: "legacy next", inputId });
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(statusOf(kernel.records()).value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" } });
  expect(turnEndAfter(kernel.records(), next.seq, "root", inputId)).toEqual({ kind: "completed" });
  assertCheckpoints(kernel.records());
});

test("handling an older attempt detaches its provisional turn without handling a reused inputId", () => {
  const kernel = createSessionKernel("root");
  const first = kernel.request("toRuntime", { kind: "prompt", input: "/spawn", inputId, admission: "native" });
  kernel.frame({ type: "start", native: {}, events: [{ kind: "turn_active" }] });
  kernel.frame({ type: "text", native: {}, events: [{ kind: "text_delta", text: "independent" }] });
  const next = kernel.request("toRuntime", { kind: "steer", input: "next attempt", inputId });
  kernel.respond(next.id, { kind: "accepted" });
  kernel.frame({ type: "handled", native: "handled", events: [handled(first)] });
  const view = viewOf(kernel.records());
  expect(view.messages.find(message => message.kind === "turn")).not.toHaveProperty("openedBy");
  const [input] = [...view.conversation.inputs.values()];
  expect(input?.attempts[0]?.disposition).toMatchObject({ kind: "handled", requestId: first.id });
  expect(input).not.toHaveProperty("disposition");
  expect(turnEndAfter(kernel.records(), next.seq, "root", inputId)).toBeNull();
  assertCheckpoints(kernel.records());
});

function fixture() {
  const kernel = createSessionKernel("root");
  const session = sealSession({ id: "root", capabilities: { queue: { durable: false }, attribution: "none", images: false },
    prompt: async (input, options) => kernel.control({ kind: "prompt", input, ...options }, request => {
      kernel.frame({ type: "handled", native: "handled", events: [handled(request)] }); return { kind: "accepted" };
    }),
    queue: async (input, options) => kernel.control({ kind: "queue", input, ...options }, () => ({ kind: "accepted", queued: "adapter" })),
    abort: async () => kernel.control({ kind: "abort" }, () => ({ kind: "accepted" })),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor), records: () => kernel.records(), graph: () => kernel.graph(), dispose: async () => {},
  });
  return { kernel, session };
}

test("scoped helpers report handling before acceptance; unscoped waits and types still require a turn", async () => {
  const { kernel, session } = fixture();
  const unscoped = awaitTurnEnd(session, -1);
  expectTypeOf(unscoped).toEqualTypeOf<Promise<TurnOutcome>>();
  expectTypeOf(turnEndAfter([], -1)).toEqualTypeOf<TurnOutcome | null>();
  expectTypeOf(turnEndAfter([], -1, "root", inputId)).toEqualTypeOf<TurnOutcome | InputHandled | null>();
  const result = await promptAndWait(session, "handled", { inputId, signal: AbortSignal.abort() });
  expect(result.kind).toBe("handled");
  const scoped = awaitTurnEnd(session, result.result.seq, inputId);
  expectTypeOf(scoped).toEqualTypeOf<Promise<TurnOutcome | InputHandled>>();
  expect(await scoped).toMatchObject({ kind: "handled" });
  expect(await awaitIdle(session)).toBeNull();
  expect(kernel.records().some(record => record.kind === "request" && record.body.kind === "abort")).toBe(false);
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(await unscoped).toEqual({ kind: "completed" });
});

test("awaitIdle notices a handled-only settlement but waits for independent native activity", async () => {
  const { kernel, session } = fixture();
  const first = kernel.request("toRuntime", { kind: "prompt", input: "handled", inputId });
  kernel.respond(first.id, { kind: "accepted" });
  const idle = awaitIdle(session);
  kernel.frame({ type: "handled", native: "handled", events: [handled(first)] });
  expect(await idle).toBeNull();
  const second = kernel.request("toRuntime", { kind: "prompt", input: "/spawn", inputId });
  kernel.frame({ type: "start", native: {}, events: [{ kind: "turn_active" }] });
  const independent = awaitIdle(session);
  kernel.frame({ type: "handled", native: "handled", events: [handled(second)] });
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(await independent).toEqual({ kind: "completed" });
});


test("an input-scoped queue wait ignores earlier ends and binds reuse to its original attempt", async () => {
  const { kernel, session } = fixture();
  const queue = kernel.request("toRuntime", { kind: "queue", input: "old", inputId });
  kernel.respond(queue.id, { kind: "accepted", queued: "adapter" });
  const pending = awaitTurnEnd(session, queue.seq, inputId);
  kernel.frame({ type: "earlier_end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(turnEndAfter(kernel.records(), queue.seq, "root", inputId)).toBeNull();
  const dispatch = kernel.request("toRuntime", { kind: "prompt", input: "old", carries: [inputId] });
  const replacement = kernel.request("toRuntime", { kind: "steer", input: "new", inputId });
  kernel.frame({ type: "new_handled", native: "handled", events: [handled(replacement)] });
  expect(turnEndAfter(kernel.records(), queue.seq, "root", inputId)).toBeNull();
  const receipt = kernel.frame({ type: "old_handled", native: "handled", events: [handled(dispatch)] });
  expect(await pending).toEqual({ kind: "handled", requestId: dispatch.id, seq: receipt.seq });
  expect(turnEndAfter(kernel.records(), queue.seq, "root", inputId)).toEqual({ kind: "handled", requestId: dispatch.id, seq: receipt.seq });
});

test("handling recorded after an independent turn ended removes its provisional attribution, not its output or outcome", async () => {
  const { kernel, session } = fixture();
  const request = kernel.request("toRuntime", { kind: "prompt", input: "/spawn", inputId, admission: "native" });
  const pending = awaitTurnEnd(session, request.seq, inputId);
  kernel.frame({ type: "start", native: {}, events: [{ kind: "turn_active" }] });
  kernel.frame({ type: "text", native: {}, events: [{ kind: "text_delta", text: "independent" }] });
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(statusOf(kernel.records(), "root").value.kind).toBe("running");
  expect(turnEndAfter(kernel.records(), request.seq, "root", inputId)).toBeNull();
  kernel.frame({ type: "handled", native: "handled", events: [handled(request)] });
  kernel.respond(request.id, { kind: "accepted" });
  expect(await pending).toMatchObject({ kind: "handled", requestId: request.id });
  const turn = viewOf(kernel.records()).messages.find(message => message.kind === "turn");
  expect(turn).not.toHaveProperty("openedBy");
  expect(turn).toMatchObject({ outcome: { kind: "completed" } });
  expect(JSON.stringify(turn)).toContain("independent");
  expect(turnEndAfter(kernel.records(), request.seq, "root", inputId)).toMatchObject({ kind: "handled", requestId: request.id });
  expect(await awaitTurnEnd(session, request.seq, inputId)).toMatchObject({ kind: "handled", requestId: request.id });
  assertCheckpoints(kernel.records());
});
