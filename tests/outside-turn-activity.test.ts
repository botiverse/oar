/* oxlint-disable eslint/max-statements -- Each control keeps the ordered boundary and its replay assertions together. */
import { afterEach, expect, test, vi } from "vitest";
import { stallOf, statusOf } from "../packages/oar/src/observe/agent-status.js";
import { initialSessionView, reduceSessionView, viewOf } from "../packages/oar/src/observe/session-view.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

afterEach(() => { vi.useRealTimers(); });

test("late root content remains activity without a running turn or stall", () => {
  vi.useFakeTimers({ now: 100 });
  const kernel = createSessionKernel("root");
  kernel.request("toRuntime", { kind: "prompt", input: "start" });
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  vi.setSystemTime(200);
  kernel.frame({ type: "late", native: {}, events: [{ kind: "text_delta", text: "working", messageId: "late" }] });
  const checkpoint = viewOf(kernel.records());
  vi.setSystemTime(300);
  const latest = kernel.frame({ type: "late", native: {}, events: [{ kind: "text_delta", text: " again", messageId: "late" }] });
  const view = reduceSessionView(checkpoint, latest);
  expect(view).toEqual(viewOf(kernel.records()));
  expect(view.status).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" }, activity: { since: 200, lastEventAt: 300 } });
  expect(statusOf(kernel.records(), "root").value).toEqual(view.status);
  expect(view.openTurn).toBe(-1);
  expect(view.messages.at(-1)).toMatchObject({ kind: "activity", sections: [{ parts: [{ kind: "text", text: "working again" }] }] });
  expect(stallOf(view.status, 20 * 60 * 1000, 15 * 60 * 1000)).toBeNull();
});

test("a prompt after outside-turn activity owns subsequent root content", () => {
  const kernel = createSessionKernel("root");
  kernel.frame({ type: "late", native: {}, events: [{ kind: "text_delta", text: "outside" }] });
  kernel.request("toRuntime", { kind: "prompt", input: "go" }, { id: "prompt" });
  kernel.frame({ type: "reply", native: {}, events: [{ kind: "text_delta", text: "inside" }] });
  const view = viewOf(kernel.records());
  expect(view.messages.map(message => message.kind)).toEqual(["activity", "input", "turn"]);
  expect(view.messages.at(-1)).toMatchObject({ kind: "turn", openedBy: "prompt", sections: [{ parts: [{ kind: "text", text: "inside" }] }] });
  expect(view.status).toMatchObject({ kind: "running", requestId: "prompt" });
  expect(view.status).not.toHaveProperty("activity");
});

test("child activity and metadata cannot adopt the root or mark root activity", () => {
  const child = { seq: 0, sessionId: "root", agentPath: ["child"], receivedAt: 20, kind: "frame" as const,
    body: { type: "child", native: {}, events: [{ kind: "text_delta" as const, text: "child" }] } };
  const view = reduceSessionView({ ...initialSessionView(), rootSessionId: "root" }, child);
  expect(view.status).toEqual({ kind: "idle" });
  expect(view.openTurn).toBe(-1);
  expect(view.messages[0]).toMatchObject({ kind: "activity", sections: [{ agentPath: ["child"] }] });
});

test("an outside-turn tool keeps its activity segment across prompts and native updates", () => {
  const kernel = createSessionKernel("root");
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "outside", tool: "shell" }] });
  const original = structuredClone(viewOf(kernel.records()));
  kernel.request("toRuntime", { kind: "prompt", input: "go" });
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  const before = viewOf(kernel.records());
  expect(before.messages[0]).toMatchObject({ kind: "activity", sections: [{ parts: [{ result: "running" }] }] });
  const update = kernel.frame({ type: "late", native: {}, events: [{ kind: "tool_call_ended", callId: "outside", result: "ok" }] });
  const after = reduceSessionView(before, update);
  expect(after).toEqual(viewOf(kernel.records()));
  expect(after.messages[0]).toMatchObject({ kind: "activity", sections: [{ parts: [{ result: "ok" }] }] });
  expect(original.messages[0]).toMatchObject({ kind: "activity", sections: [{ parts: [{ result: "running" }] }] });
  expect(after.openTurn).toBe(-1);
});

test("exit closes unresolved outside-turn root tools and clears activity without inventing an outcome", () => {
  const kernel = createSessionKernel("root");
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "outside", tool: "shell" }] });
  kernel.respond("", { kind: "exited", code: 0 });
  const view = viewOf(kernel.records());
  expect(view.status).toEqual({ kind: "idle" });
  expect(view.messages.map(message => message.kind)).toEqual(["activity", "notice"]);
  expect(view.messages[0]).toMatchObject({ kind: "activity", sections: [{ parts: [{ result: "ended" }] }] });
});

test("content in a sliced log needs its start or a checkpoint to recover the running turn", () => {
  const kernel = createSessionKernel("root");
  kernel.frame({ type: "native-start", native: {}, events: [{ kind: "turn_active" }] });
  const checkpoint = structuredClone(viewOf(kernel.records()));
  const content = kernel.frame({ type: "text", native: {}, events: [{ kind: "text_delta", text: "inside" }] });
  expect(viewOf([content]).messages[0]?.kind).toBe("activity");
  expect(viewOf([content]).status.kind).toBe("idle");
  expect(reduceSessionView(checkpoint, content)).toEqual(viewOf(kernel.records()));
  expect(viewOf(kernel.records()).status.kind).toBe("running");
});
