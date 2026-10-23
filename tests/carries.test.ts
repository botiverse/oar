import { expect, test } from "vitest";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { conversationOf, reduceConversation } from "../packages/oar/src/observe/conversation.js";
import { initialSessionView, reduceSessionView } from "../packages/oar/src/observe/session-view.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const aggregateId = "22222222-2222-4222-8222-222222222222";
async function carried() {
  const kernel = createSessionKernel("root");
  await kernel.control({ kind: "queue", inputId: firstId, input: "original", images: [{ path: "/image.png" }], origin: { kind: "automation", source: "build" } }, () => ({ kind: "accepted" }));
  await kernel.control({ kind: "withdraw", inputId: firstId }, () => ({ kind: "accepted" }));
  return kernel;
}

test.each(["accepted", "rejected"] as const)("a %s aggregate settles carried attempts while preserving each original input", async (kind) => {
  const kernel = await carried();
  const prompt = await kernel.control({ kind: "prompt", inputId: aggregateId, input: "transformed", carries: [firstId] }, () => kind === "accepted" ? { kind } : { kind, code: "error", reason: "refused" });
  const input = conversationOf(kernel.records()).inputs.get(JSON.stringify(["root", [], firstId]));
  expect(input).toMatchObject({ input: "original", images: [{ path: "/image.png" }], origin: { kind: "automation", source: "build" }, state: kind });
  expect(input?.attempts.at(-1)?.request).toBe(prompt.request);
  const view = kernel.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
  expect(view.messages.flatMap((message) => message.kind === "input" ? [message.input.input] : [])).toEqual(["original"]);
});

test("native queue, start and drop evidence for an aggregate reaches the carried inputs", async () => {
  const kernel = await carried();
  await kernel.control({ kind: "prompt", inputId: aggregateId, input: "transformed", carries: [firstId] }, () => ({ kind: "accepted" }));
  kernel.frame({ type: "queued", native: {}, events: [{ kind: "input_queued", inputId: aggregateId }] });
  const read = () => conversationOf(kernel.records()).inputs.get(JSON.stringify(["root", [], firstId]));
  expect(read()?.turn?.state).toBe("queued");
  kernel.frame({ type: "active", native: {}, events: [{ kind: "turn_active", inputId: aggregateId }] });
  expect(read()?.turn?.state).toBe("active");
  kernel.frame({ type: "dropped", native: {}, events: [{ kind: "input_dropped", inputId: aggregateId, reason: "runtime_refused" }] });
  expect(read()?.state).toBe("dropped");
});

test("carries never links a foreign agent or fabricates a missing input", async () => {
  const kernel = await carried();
  await kernel.control({ kind: "prompt", inputId: aggregateId, input: "child", carries: [firstId] }, () => ({ kind: "accepted" }), { agentPath: ["child"] });
  expect(conversationOf(kernel.records()).inputs.get(JSON.stringify(["root", [], firstId]))?.state).toBe("withdrawn");
  const view = kernel.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
  expect(view.messages.flatMap((message) => message.kind === "input" ? [message.input.input] : [])).toEqual(["child"]);
});

// oxlint-disable-next-line eslint/max-statements -- Keep the before-exit and resumed stream evidence in one scenario.
test("a resumed aggregate echo restores carried exit uncertainty without inventing individual echoes", async () => {
  const kernel = await carried();
  await kernel.control({ kind: "prompt", inputId: aggregateId, input: "transformed", carries: [firstId] }, () => ({ kind: "accepted" }));
  kernel.frame({ type: "queued", native: {}, events: [{ kind: "input_queued", inputId: aggregateId }] });
  kernel.respond("", { kind: "exited", code: 1 });
  const before = conversationOf(kernel.records());
  expect(before.inputs.get(JSON.stringify(["root", [], firstId]))).toMatchObject({ state: "dropped", reason: "runtime_exited" });
  const resumed = createSessionKernel("root");
  const echo = resumed.frame({ type: "history", native: {}, events: [{ kind: "user_message", inputId: aggregateId, input: "transformed", evidence: "conversation" }] });
  const after = reduceConversation(before, echo, "resume");
  expect(after.inputs.get(JSON.stringify(["root", [], firstId]))).toMatchObject({ state: "accepted", observations: [] });
  expect(after.inputs.get(JSON.stringify(["root", [], aggregateId]))?.observations).toHaveLength(1);
});

// oxlint-disable-next-line eslint/max-statements -- Both queue deferral and activation are checked against the same view.
test("a queued aggregate remains hidden when another native turn defers the originals", async () => {
  const kernel = await carried();
  await kernel.control({ kind: "prompt", inputId: aggregateId, input: "transformed", carries: [firstId] }, () => ({ kind: "accepted" }));
  kernel.frame({ type: "queued", native: {}, events: [{ kind: "input_queued", inputId: aggregateId }] });
  kernel.frame({ type: "active", native: {}, events: [{ kind: "turn_active", inputId: "other" }] });
  const view = kernel.records().reduce((state, record) => reduceSessionView(state, record), initialSessionView());
  expect(view.pendingInputs.map((input) => input.input)).toEqual(["original"]);
  expect(view.messages.flatMap((message) => message.kind === "input" ? [message.input.input] : [])).toEqual([]);
  const active = kernel.frame({ type: "active", native: {}, events: [{ kind: "turn_active", inputId: aggregateId }] });
  const started = reduceSessionView(view, active);
  expect(started.pendingInputs).toEqual([]);
  expect(started.messages.flatMap((message) => message.kind === "input" ? [message.input.input] : [])).toEqual(["original"]);
});

test("a late aggregate response settles the carries on that request, independently of a retry", async () => {
  const kernel = await carried();
  const old = kernel.request("toRuntime", { kind: "prompt", inputId: aggregateId, input: "transformed", carries: [firstId] });
  const retry = kernel.request("toRuntime", { kind: "prompt", inputId: aggregateId, input: "retry alone" });
  kernel.respond(retry.id, { kind: "rejected", code: "busy", reason: "busy" });
  kernel.respond(old.id, { kind: "accepted" });
  expect(conversationOf(kernel.records()).inputs.get(JSON.stringify(["root", [], firstId]))?.state).toBe("accepted");
});

// oxlint-disable-next-line eslint/max-statements -- Each state is checked before and after the refused control.
test.each(["queued", "pending-withdraw", "requeued", "foreign-agent", "foreign-session", "missing"])("carries rejects caller-unowned input: %s", async (state) => {
  const kernel = createSessionKernel("root");
  const at = { ...(state === "foreign-agent" ? { agentPath: ["child"] } : {}), ...(state === "foreign-session" ? { sessionId: "other" } : {}) };
  if (state !== "missing") {
    await kernel.control({ kind: "queue", inputId: firstId, input: "original" }, () => ({ kind: "accepted" }), at);
    if (state === "pending-withdraw") { kernel.request("toRuntime", { kind: "withdraw", inputId: firstId }, at); }
    else if (state !== "queued") { await kernel.control({ kind: "withdraw", inputId: firstId }, () => ({ kind: "accepted" }), at); }
    if (state === "requeued") { await kernel.control({ kind: "queue", inputId: firstId, input: "original" }, () => ({ kind: "accepted" })); }
  }
  const original = conversationOf(kernel.records()).inputs.get(JSON.stringify([at.sessionId ?? "root", at.agentPath ?? [], firstId]));
  let called = false;
  const result = await kernel.control({ kind: "prompt", inputId: aggregateId, input: "merged", carries: [firstId] }, () => { called = true; return { kind: "accepted" }; });
  expect(result.response.body).toEqual({ kind: "rejected", code: "unsupported", reason: `carries input ${firstId} is not a withdrawn input owned by this session and agent` });
  expect(called).toBe(false);
  expect(conversationOf(kernel.records()).inputs.get(JSON.stringify([at.sessionId ?? "root", at.agentPath ?? [], firstId]))).toEqual(original);
});
