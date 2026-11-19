import { expect, test } from "vitest";
import { createSessionKernel, sealSession } from "../packages/oar/src/kernel.js";
import type { Event } from "../packages/oar/src/contracts/session.js";
import { observeConversation } from "../packages/oar/src/observe/conversation.js";
import { initialSessionView, observeSessionView, reduceSessionView, reduceSessionViewEvent, viewOf } from "../packages/oar/src/observe/session-view.js";
import { graphOf } from "../packages/oar/src/observe/graph.js";

function fixture() {
  const kernel = createSessionKernel("root");
  const session = sealSession({ id: "root", capabilities: { queue: { durable: false }, attribution: "none", images: false },
    prompt: async (input) => kernel.control({ kind: "prompt", input }, () => ({ kind: "accepted" })),
    queue: async (input) => kernel.control({ kind: "queue", input }, () => ({ kind: "accepted", queued: "adapter" })),
    abort: async () => kernel.control({ kind: "abort" }, () => ({ kind: "accepted" })),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor), records: () => kernel.records(), graph: () => kernel.graph(), dispose: async () => {},
  });
  return { kernel, session };
}

test.each(["replay", "live", "omitted"] as const)("events keeps pre-cursor controls for %s responses", (mode) => {
  const { session, rejected, withdrawn, respond } = controls();
  const events: Event[] = [];
  if (mode === "replay") { respond(); }
  session.events(event => { events.push(event); }, mode === "omitted" ? {} : { cursor: { sessionId: session.id, afterSeq: withdrawn.seq } });
  if (mode !== "replay") { respond(); }
  expect(events).toMatchObject([{ kind: "control_rejected", action: "abort", requestId: rejected.id }, { kind: "input_withdrawn", inputId: "held", requestId: withdrawn.id }]);
});

function controls() {
  const { kernel, session } = fixture();
  const rejected = kernel.request("toRuntime", { kind: "abort" });
  const withdrawn = kernel.request("toRuntime", { kind: "withdraw", inputId: "held" });
  const respond = () => {
    kernel.respond(rejected.id, { kind: "rejected", code: "no_active_turn", reason: "idle" });
    kernel.respond(withdrawn.id, { kind: "accepted" });
  };
  return { session, rejected, withdrawn, respond };
}

test.each([observeConversation, observeSessionView])("state observers deliver the current state once, then each new record", (observe) => {
  const { kernel, session } = fixture();
  const counts: number[] = [];
  kernel.request("toRuntime", { kind: "prompt", input: "first" });
  kernel.request("toRuntime", { kind: "prompt", input: "second" });
  const stop = observe(session, state => { counts.push(("conversation" in state ? state.conversation : state).inputs.size); });
  expect(counts).toEqual([2]);
  kernel.request("toRuntime", { kind: "prompt", input: "third" });
  expect(counts).toEqual([2, 3]);
  stop();
});

test.each([observeConversation, observeSessionView])("state observers respect explicit replay boundaries", observe => {
  const { kernel, session } = fixture();
  const first = kernel.request("toRuntime", { kind: "prompt", input: "first" });
  const second = kernel.request("toRuntime", { kind: "prompt", input: "second" });
  for (const [afterSeq, expected] of [[-1, [1, 2]], [first.seq, [2]], [second.seq, []]] as const) {
    const replay: number[] = [];
    observe(session, state => { replay.push(("conversation" in state ? state.conversation : state).inputs.size); }, { sessionId: session.id, afterSeq })();
    expect(replay).toEqual(expected);
  }
  expect(() => observe(session, () => {}, { sessionId: "other", afterSeq: -1 })).toThrow(/cursor/u);
});

test.each([observeConversation, observeSessionView])("empty state subscriptions wait for the first record", observe => {
  const { kernel, session } = fixture();
  const counts: number[] = [];
  observe(session, state => { counts.push(("conversation" in state ? state.conversation : state).inputs.size); });
  expect(counts).toEqual([]);
  kernel.request("toRuntime", { kind: "prompt", input: "first" });
  expect(counts).toEqual([1]);
});

test("cycle and self reports establish nodes without circular ancestry", () => {
  const { kernel } = fixture();
  for (const [parent, child] of [["a","a"], ["a","b"], ["b","c"], ["c","a"]] as const) {
    kernel.frame({ type: "lineage", native: {}, events: [{ kind: "session_linked", parent, child, via: "tool_call" }] });
  }
  expect(graphOf(kernel.records()).edges.map(e => [e.parent, e.child])).toEqual([["a","b"],["b","c"]]);
  expect(kernel.graph().edges).toEqual(graphOf(kernel.records()).edges);
});

test("a child-first stream with no prompt retains the actual root model and id", () => {
  const { kernel, session } = fixture();
  kernel.frame({ type: "model", native: {}, events: [{ kind: "model", model: "child-model" }] }, { sessionId: "child" });
  kernel.frame({ type: "catalog", native: {}, events: [{ kind: "session_linked", parent: "root", child: "child", via: "tool_call" }, { kind: "model", model: "root-model" }] });
  const view = viewOf(kernel.records());
  expect(view).toMatchObject({ rootSessionId: "root", model: "root-model" });
  let last: unknown = null;
  observeSessionView(session, current => { last = current; }, { sessionId: session.id, afterSeq: -1 });
  expect(last).toMatchObject({ rootSessionId: "root", model: "root-model" });
});

test("the caller's root survives foreign prompts in records and flat events", () => {
  const { kernel } = fixture();
  const child = kernel.request("toRuntime", { kind: "prompt", input: "child" }, { sessionId: "child" });
  const initial = initialSessionView("root");
  expect(reduceSessionView(initial, child).rootSessionId).toBe("root");
  expect(reduceSessionViewEvent(initial, { ...child, kind: "turn_started", requestId: child.id, input: "child" }).rootSessionId).toBe("root");
});

test.each(["prompt", "link", "open"] as const)("a later root %s corrects a provisional child", source => {
  const { kernel } = fixture();
  const first = kernel.frame({ type: "child", native: {}, events: [{ kind: "model", model: "child-model" }] }, { sessionId: "child" });
  const signals = {
    prompt: () => kernel.request("toRuntime", { kind: "prompt", input: "start" }),
    open: () => kernel.respond("open-id", { kind: "opened", placement: "isolated" }),
    link: () => kernel.frame({ type: "catalog", native: {}, events: [{ kind: "session_linked", parent: "root", child: "child", via: "tool_call" }] }),
  };
  const next = signals[source]();
  const provisional = reduceSessionView(initialSessionView(), first);
  expect(provisional).toMatchObject({ rootSessionId: "child", model: "child-model" });
  expect(reduceSessionView(provisional, next)).toMatchObject({ rootSessionId: "root", model: null });
});

test("coalescing across a cursor emits only text after the boundary", () => {
  const { kernel, session } = fixture();
  const text = (value: string) => kernel.frame({ type: "text", native: {}, events: [{ kind: "text_delta", text: value }] });
  const prefix = text("before");
  text("after");
  kernel.frame({ type: "model", native: {}, events: [{ kind: "model", model: "a" }] });
  const events: Event[] = [];
  session.events(event => { events.push(event); }, { cursor: { sessionId: session.id, afterSeq: prefix.seq }, coalesceText: true });
  expect(events).toMatchObject([{ kind: "text_delta", text: "after" }, { kind: "model", model: "a" }]);
});
