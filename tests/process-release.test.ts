import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent, Session } from "../packages/oar/src/contracts/session.js";
import { createProcessPool } from "../packages/oar/src/shared/process-pool.js";
import { processSessionLifecycle } from "../packages/oar/src/shared/process-session.js";
import { createSessionKernel, sealSession } from "../packages/oar/src/kernel.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";
import { awaitTurnEnd, turnEndAfter, statusOf } from "../packages/oar/src/observe/index.js";
import { tasksOf } from "../packages/oar/src/observe/tasks.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { viewOf, reduceSessionView } from "../packages/oar/src/observe/session-view.js";

const config = { command: "/mock", args: [], env: {} };
function fixture() {
  const exit = Promise.withResolvers<number | null>();
  const process = { exited: exit.promise, stop: vi.fn(() => { exit.resolve(0); }),
    resources: async () => { await Promise.resolve(); return { rss: 100, processes: 1 }; } };
  const start = vi.fn(async () => { await Promise.resolve(); return process; });
  const pool = createProcessPool(start);
  const open = async (cleanup = async (): Promise<void> => { await Promise.resolve(); }, placement: "shared" | "isolated" = "shared") => {
    const lease = await pool.acquire(config, placement);
    const redactor = sessionCredentialRedactor({ env: { API_KEY: "synthetic-test-secret" } });
    const kernel = createSessionKernel(undefined, redactor.redactValue);
    kernel.opened({ requested: placement, placement });
    const lifecycle = processSessionLifecycle(kernel, lease, cleanup, 20);
    const session = sealSession({
      id: kernel.sessionId, capabilities: { images: false, attribution: "none", queue: { durable: false } },
      prompt: async (input, options) => kernel.control({ kind: "prompt", input, ...options }, () => ({ kind: "accepted" })),
      queue: async (input, options) => kernel.control({ kind: "queue", input, ...options }, () => ({ kind: "accepted" })),
      abort: async () => lifecycle.abortFallback(kernel.request("toRuntime", { kind: "abort" })),
      records: () => kernel.records(), rawEvents: (...args) => kernel.rawEvents(...args), graph: () => kernel.graph(),
      dispose: lifecycle.dispose, resources: lease.resources,
    });
    return { kernel, session, lifecycle };
  };
  return { open, process, start, exit: exit.resolve };
}
const bodies = (session: Session) => session.records().filter((record) => record.kind === "response").map((record) => record.body);
afterEach(() => { vi.useRealTimers(); });

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("shared abort fallback ends the wait, retains late facts, and leaves a peer running", async () => {
  const f = fixture();
  const cleanup = vi.fn(async () => { await Promise.resolve(); });
  const a = await f.open(cleanup);
  const b = await f.open();
  const prompt = await a.session.prompt("work");
  await b.session.prompt("peer");
  a.kernel.frame({ type: "task", native: { id: "background" }, events: [{ kind: "task_started", taskId: "background", taskType: "shell", background: true }] });
  const waiting = awaitTurnEnd(a.session, prompt.seq);
  const aborted = await a.session.abort();
  expect(aborted.kind).toBe("accepted");
  await expect(waiting).resolves.toEqual({ kind: "aborted" });
  expect(b.session.status().value.kind).toBe("running");
  expect(f.process.stop).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(bodies(a.session).find((body) => body.kind === "released")).toMatchInlineSnapshot(`
    {
      "kind": "released",
      "nativeTurnMayContinue": true,
      "reason": "abort_fallback",
      "workStartedAfterCleanupMayContinue": true,
    }
  `);
  const count = a.session.records().length;
  a.kernel.frame({ type: "late", native: { text: "after release" }, events: [{ kind: "text_delta", text: "after release" }, { kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(a.session.records()).toHaveLength(count + 1);
  expect(a.session.status().value).toEqual({ kind: "idle", released: true, lastTurnOutcome: { kind: "aborted" } });
  expect(turnEndAfter(a.session.records(), prompt.seq, a.session.id)).toEqual({ kind: "aborted" });
  expect(a.session.records().flatMap((record) => eventsOf(record)).some((event) => event.kind === "text_delta" && event.text === "after release")).toBe(true);
  expect(tasksOf(a.session.records(), a.session.id).value[0]?.status).toBe("running");
  expect(await a.session.prompt("again")).toMatchObject({ kind: "rejected", code: "session_released" });
  const replay: RawEvent[] = [];
  a.session.rawEvents((event) => { replay.push(event); }, { sessionId: a.session.id, afterSeq: -1 })();
  expect(replay).toEqual(a.session.records());
  await a.session.dispose();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(f.process.stop).not.toHaveBeenCalled();
  expect(await a.session.prompt("after dispose")).toMatchObject({ kind: "rejected", code: "disposed" });
  await b.session.dispose();
  expect(f.process.stop).toHaveBeenCalledTimes(1);
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("dispose releases one running owner, last dispose observes actual exit", async () => {
  const f = fixture(); const a = await f.open(); const b = await f.open();
  const prompt = await a.session.prompt("work");
  await a.session.dispose();
  expect(await a.session.prompt("after dispose")).toMatchObject({ kind: "rejected", code: "disposed" });
  expect(turnEndAfter(a.session.records(), prompt.seq, a.session.id)).toEqual({ kind: "aborted" });
  expect(bodies(a.session).filter((body) => body.kind === "exited")).toHaveLength(0);
  expect(a.session.records().filter((record) => record.kind === "frame")).toHaveLength(0);
  await b.session.dispose();
  expect(bodies(a.session).filter((body) => body.kind === "exited")).toEqual([{ kind: "exited", code: 0 }]);
  expect(bodies(b.session).at(-1)).toEqual({ kind: "exited", code: 0 });
});

test("cleanup failures stay visible and redacted, without killing a peer", async () => {
  const f = fixture(); const a = await f.open(async () => { await Promise.resolve(); throw new Error("failed synthetic-test-secret"); }); const b = await f.open();
  await a.session.prompt("work");
  await a.session.abort();
  expect(bodies(a.session)).toContainEqual({ kind: "cleanup", result: { kind: "failed", reason: "failed [redacted]" } });
  expect(JSON.stringify(a.session.records())).not.toContain("synthetic-test-secret");
  expect(f.process.stop).not.toHaveBeenCalled();
  await Promise.all([a.session.dispose(), b.session.dispose()]);
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("a stuck cleanup is bounded and dispose retries cleanup without blocking peers", async () => {
  vi.useFakeTimers();
  const cleanup = vi.fn(async () => Promise.withResolvers<void>().promise);
  const f = fixture(); const a = await f.open(cleanup); const b = await f.open();
  await a.session.prompt("work");
  const aborted = a.session.abort();
  await vi.advanceTimersByTimeAsync(21);
  await aborted;
  expect(bodies(a.session)).toContainEqual({ kind: "cleanup", result: { kind: "failed", reason: "session cleanup timed out; work may still be running" } });
  const disposed = a.session.dispose();
  await vi.advanceTimersByTimeAsync(21); await disposed;
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(f.process.stop).not.toHaveBeenCalled();
  await b.session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("unrequested shared-process death is reported once to every live session", async () => {
  const f = fixture(); const a = await f.open(); const b = await f.open();
  const pa = await a.session.prompt("a"); const pb = await b.session.prompt("b");
  f.exit(7); await f.process.exited;
  for (const [session, seq] of [[a.session, pa.seq], [b.session, pb.seq]] as const) {
    expect(bodies(session).filter((body) => body.kind === "exited")).toEqual([{ kind: "exited", code: 7 }]);
    expect(turnEndAfter(session.records(), seq, session.id)).toEqual({ kind: "failed", reason: "runtime exited", failure: "runtime_exited" });
  }
  expect(f.start).toHaveBeenCalledTimes(1);
  await Promise.all([a.session.dispose(), b.session.dispose()]);
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("abort fallback closes control before cleanup settles, even if native completion arrives", async () => {
  const cleaned = Promise.withResolvers<void>();
  const f = fixture(); const a = await f.open(async () => { await cleaned.promise; }); const b = await f.open();
  const prompt = await a.session.prompt("work");
  const abort = a.session.abort();
  a.kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  expect(await a.session.prompt("during cleanup")).toMatchObject({ kind: "rejected", code: "session_released" });
  expect(turnEndAfter(a.session.records(), prompt.seq, a.session.id)).toEqual({ kind: "aborted" });
  cleaned.resolve(); await abort;
  await Promise.all([a.session.dispose(), b.session.dispose()]);
  expect(f.process.stop).toHaveBeenCalledTimes(1);
});

test("concurrent disposal runs each cleanup once and stops the process only after the last owner", async () => {
  const cleanup = vi.fn(async () => { await Promise.resolve(); });
  const f = fixture(); const a = await f.open(cleanup); const b = await f.open(cleanup);
  await Promise.all([a.session.dispose(), a.session.dispose(), b.session.dispose()]);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(f.process.stop).toHaveBeenCalledTimes(1);
  for (const { session } of [a, b]) {
    expect(session.records().filter((record) => record.kind === "request" && record.body.kind === "dispose")).toHaveLength(1);
    expect(bodies(session).filter((body) => body.kind === "exited")).toEqual([{ kind: "exited", code: 0 }]);
  }
});

// oxlint-disable-next-line eslint/max-statements -- Keep the ownership transitions and their observations in one chronological regression.
test("release leaves tool execution unknown and retains late evidence without reopening the OAR wait", async () => {
  const f = fixture(); const a = await f.open(); const b = await f.open();
  await a.session.prompt("work");
  a.kernel.frame({ type: "start", native: {}, events: [{ kind: "tool_call_started", callId: "call", tool: "shell" }] });
  await a.session.abort();
  const before = viewOf(a.session.records());
  const tools = before.messages.flatMap((message) => message.kind === "turn" ? message.sections.flatMap((section) => section.parts.filter((part) => part.kind === "tool")) : []);
  expect(tools).toHaveLength(1);
  expect(tools[0]?.result).toBe("running");
  const cursor = a.session.records().length;
  a.kernel.frame({ type: "late", native: {}, events: [
    { kind: "tool_call_ended", callId: "call", result: "ok" },
    { kind: "text_delta", text: "native work continued" },
    { kind: "turn_ended", outcome: { kind: "completed" } },
  ] });
  a.kernel.request("toApp", { kind: "native", type: "question", native: {} });
  const after = viewOf(a.session.records());
  expect(a.session.records().slice(cursor).reduce((state, record) => reduceSessionView(state, record), structuredClone(before))).toEqual(after);
  expect(after.status).toEqual({ kind: "idle", released: true, lastTurnOutcome: { kind: "aborted" } });
  expect(after.pendingRequests).toEqual([]);
  expect(after.messages.filter((message) => message.kind === "turn").map((turn) => turn.outcome)).toEqual([{ kind: "aborted" }, { kind: "completed" }, undefined]);
  await Promise.all([a.session.dispose(), b.session.dispose()]);
});

test("isolated abort fallback stops its process and records exit, not release", async () => {
  const f = fixture(); const a = await f.open(undefined, "isolated");
  const prompt = await a.session.prompt("work"); await a.session.abort();
  expect(f.process.stop).toHaveBeenCalledTimes(1);
  expect(bodies(a.session).at(-1)).toEqual({ kind: "exited", code: 0 });
  expect(turnEndAfter(a.session.records(), prompt.seq, a.session.id)).toEqual({ kind: "aborted" });
  expect(bodies(a.session).some((body) => body.kind === "released")).toBe(false);
  await a.session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Follow one tool across release and later real exit.
test("actual exit ends unresolved tools in a previously released turn", async () => {
  const f = fixture(); const a = await f.open(); const b = await f.open();
  await a.session.prompt("work");
  a.kernel.frame({ type: "start", native: {}, events: [{ kind: "tool_call_started", callId: "call", tool: "shell" }] });
  await a.session.abort();
  f.exit(7); await f.process.exited;
  const view = viewOf(a.session.records());
  expect(view.messages.flatMap((message) => message.kind === "turn" ? message.sections.flatMap((section) => section.parts.filter((part) => part.kind === "tool")) : []).map((tool) => tool.result)).toEqual(["ended"]);
  expect(view.exited).toEqual({ code: 7 });
  await Promise.all([a.session.dispose(), b.session.dispose()]);
});

test("refused or old aborts do not turn an unrelated release into aborted", async () => {
  const kernel = createSessionKernel("s");
  const old = kernel.request("toRuntime", { kind: "prompt", input: "old" });
  kernel.respond(old.id, { kind: "accepted" });
  await kernel.control({ kind: "abort" }, () => ({ kind: "accepted" }));
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  const current = kernel.request("toRuntime", { kind: "prompt", input: "new" });
  kernel.respond(current.id, { kind: "accepted" });
  await kernel.control({ kind: "abort" }, () => ({ kind: "rejected", code: "runtime_refused", reason: "no" }));
  kernel.respond("", { kind: "released", reason: "abort_fallback", nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true });
  expect(turnEndAfter(kernel.records(), current.seq, "s")).toEqual({ kind: "failed", reason: "session released; native work may continue", failure: "unknown" });
});

test("a child release or exit cannot close the root session", async () => {
  const kernel = createSessionKernel("parent");
  const prompt = kernel.request("toRuntime", { kind: "prompt", input: "parent" });
  kernel.respond(prompt.id, { kind: "accepted" });
  kernel.respond("child", { kind: "released", reason: "dispose", nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true }, { sessionId: "child" });
  kernel.respond("child", { kind: "exited", code: 0 }, { agentPath: ["child"] });
  expect(kernel.unreachable()).toBeNull();
  expect(statusOf(kernel.records(), "parent").value.kind).toBe("running");
  const queued = await kernel.control({ kind: "queue", input: "still open" }, () => ({ kind: "accepted" }));
  expect(queued.response.body.kind).toBe("accepted");
});
