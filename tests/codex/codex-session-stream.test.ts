/* oxlint-disable eslint/max-lines -- Stream/control sequencing tests share the scripted app-server below. */
import { afterEach, expect, test, vi } from "vitest";
import type { ControlResult, ResponseBody, RawEvent } from "../../packages/oar/src/contracts/session.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import { steer } from "../fixtures/steer.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.153.4" } as const;
const threadId = "thread-123";

afterEach(() => {
  spawnLineProcess.mockReset();
  vi.useRealTimers();
});

function notify(process: FakeLineProcess, method: string, params: Record<string, unknown>): void {
  process.emit(`${JSON.stringify({ method, params })}\n`);
}

/** turn/start: reply, start turn-1, and (unless the prompt is "hold") stream a delta and complete; "ask" first sends a SERVER request (an approval). */
function scriptTurnStart(process: FakeLineProcess, params: JsonRecord): void {
  const input = asRecord((Array.isArray(params.input) ? params.input : [])[0])?.text;
  notify(process, "turn/started", { threadId, turn: { id: "turn-1" } });
  if (input === "ask") {
    process.emit(`${JSON.stringify({ id: "srv-7", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "turn-1", itemId: "exec-1" } })}\n`);
  }
  if (input !== "hold") {
    notify(process, "item/agentMessage/delta", { threadId, turnId: "turn-1", delta: "ok" });
    notify(process, "turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
  }
}

function replyFor(method: string, params: JsonRecord, interruptFails: boolean): JsonRecord | null {
  switch (method) {
    case "thread/start":
      return { thread: { id: threadId }, model: "gpt-5.5" };
    case "turn/start":
      return { turn: { id: "turn-1" } };
    case "turn/interrupt":
      return interruptFails ? null : {};
    case "turn/steer":
      return { turnId: params.expectedTurnId };
    case "thread/queue/add":
      return { submissionId: "sub-9" };
    default:
      return {};
  }
}

function answer(process: FakeLineProcess, message: { id: number; method: string; params: JsonRecord }, interruptFails: boolean): void {
  const { id, method, params } = message;
  const result = replyFor(method, params, interruptFails);
  if (result === null) {
    process.emit(`${JSON.stringify({ id, error: { message: "turn already finished" } })}\n`);
    return;
  }
  process.emit(`${JSON.stringify({ id, result })}\n`);
  if (method === "turn/start") {
    scriptTurnStart(process, params);
  } else if (method === "turn/interrupt") {
    notify(process, "turn/completed", { threadId, turn: { id: "turn-1", status: "interrupted" } });
  }
}

/** A scripted app-server for the stream shape; `interruptFails` makes turn/interrupt answer with an RPC error. */
function scriptedAppServer(options: { interruptFails?: boolean; interruptHangs?: boolean; interruptAckOnly?: boolean } = {}): FakeLineProcess {
  let ended = false;
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (!ended && typeof message?.id === "number" && typeof message.method === "string") {
      if (message.method === "turn/interrupt" && (options.interruptHangs === true || options.interruptAckOnly === true)) {
        if (options.interruptAckOnly === true) { process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`); }
        return;
      }
      answer(process, { id: message.id, method: message.method, params: asRecord(message.params) ?? {} }, options.interruptFails === true);
    }
  });
  fake.onExit(() => {
    ended = true;
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

function skeleton(records: readonly RawEvent[]): string[] {
  return records.map((record) => {
    switch (record.kind) {
      case "request":
        return `${record.direction} ${record.body.kind}${record.body.kind === "native" ? `:${record.body.type}` : ""}`;
      case "response":
        return `response ${record.body.kind}`;
      case "frame":
        return `event ${record.body.type}${record.spanId === undefined ? "" : ` span=${record.spanId}`}${record.body.events.length === 0 ? "" : ` → ${record.body.events.map((view) => view.kind).join(",")}`}`;
      default:
        return "?";
    }
  });
}

test("a prompt is one request/response pair, the turn ends on codex's own turn/completed, spanId is codex's turn id", async () => {
  const fake = scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work" });
  const result = await session.prompt("hi");
  expect(result.response.body).toEqual({ kind: "accepted", native: { turn: { id: "turn-1" } } });
  expect(await awaitTurnEnd(session, result.request.seq)).toEqual({ kind: "completed" });
  expect(session.model().value).toBe("gpt-5.5");
  await session.dispose();
  expect(skeleton(session.records())).toEqual([
    "event thread/start → model",
    "toRuntime prompt",
    "response accepted",
    "event turn/started span=turn-1 → turn_active",
    "event item/agentMessage/delta span=turn-1 → text_delta",
    "event turn/completed span=turn-1 → turn_ended",
    "toRuntime dispose",
    "response exited",
  ]);
  expect(fake.killed()).toBe(true);
});

/** The response bodies of several control calls, in order. */
async function bodiesOf(calls: readonly Promise<ControlResult>[]): Promise<ResponseBody[]> {
  const results = await Promise.all(calls);
  return results.map((result) => result.response.body);
}

// oxlint-disable-next-line eslint/max-statements -- Pin acceptance, drop, queue isolation and later refusal in one transport sequence.
test("busy while a turn runs; steer, queue and abort answer through the RPC replies", async () => {
  scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work" });
  const held = await session.prompt("hold");
  expect(held.response.body.kind).toBe("accepted");
  expect(await bodiesOf([session.prompt("again"), steer(session, "more"), session.queue("later"), session.abort()])).toEqual([
    { kind: "rejected", code: "busy", reason: "busy" },
    { kind: "accepted", native: { turnId: "turn-1" } },
    { kind: "accepted", native: { submissionId: "sub-9" } },
    { kind: "accepted", native: {} },
  ]);
  // The queue is codex's own (thread/queue/add): OAR offers no withdraw until thread/queue/delete is verified.
  expect("withdraw" in session).toBe(false);
  expect(await awaitTurnEnd(session, held.request.seq)).toEqual({ kind: "aborted" });
  const drops = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "input_dropped") : []);
  const acceptedSteer = session.records().find((record) => record.kind === "request" && record.body.kind === "steer");
  expect(drops).toEqual([{ kind: "input_dropped", inputId: acceptedSteer?.kind === "request" && "inputId" in acceptedSteer.body ? acceptedSteer.body.inputId : undefined, reason: "turn_interrupted" }]);
  expect(await bodiesOf([session.abort(), steer(session, "late")])).toEqual([
    { kind: "rejected", code: "no_active_turn", reason: "no active turn" },
    { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" },
  ]);
  await session.dispose();
  // dispose awaited the exit, so the stream holds an exited response and the
  // kernel's reachability answer reads that first.
  expect(await bodiesOf([session.prompt("dead")])).toEqual([{ kind: "rejected", code: "runtime_exited", reason: "runtime exited" }]);
});

test("an interrupt the runtime refuses is a rejected abort, not an error", async () => {
  vi.useFakeTimers();
  const fake = scriptedAppServer({ interruptFails: true });
  const session = await codexSession(installation, { cwd: "/work" });
  await session.prompt("hold");
  const aborted = await session.abort();
  expect(aborted.response.body).toEqual({ kind: "rejected", code: "runtime_refused", reason: "turn already finished" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fake.killed()).toBe(false);
  await session.dispose();
});

test("deliver prompts when codex refuses its steer because the turn ended in flight", async () => {
  // codex 0.158.0 answers turn/steer for a completed turn with an RPC error,
  // "no active turn to steer"; here the turn completes while the steer is on the wire.
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    if (message.method === "turn/steer") {
      notify(process, "turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
      process.emit(`${JSON.stringify({ id: message.id, error: { message: "no active turn to steer" } })}\n`);
      return;
    }
    answer(process, { id: message.id, method: message.method, params: asRecord(message.params) ?? {} }, false);
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  await session.prompt("hold");
  const delivered = await session.deliver("report");
  expect(delivered).toMatchObject({ landed: "prompted" });
  const attempts = session.records().flatMap((record) =>
    record.kind === "request" && (record.body.kind === "steer" || record.body.kind === "prompt") && record.body.input === "report"
      ? [{ kind: record.body.kind, inputId: record.body.inputId }]
      : []);
  expect(attempts).toEqual([{ kind: "steer", inputId: delivered.inputId }, { kind: "prompt", inputId: delivered.inputId }]);
  await session.dispose();
});

test("a server-initiated request is recorded verbatim as a toApp request and left unanswered", async () => {
  scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work" });
  const result = await session.prompt("ask");
  await awaitTurnEnd(session, result.request.seq);
  const toApp = session.records().find((record) => record.kind === "request" && record.direction === "toApp");
  expect(toApp).toMatchObject({
    kind: "request",
    id: "srv-7",
    direction: "toApp",
    body: { kind: "native", type: "item/commandExecution/requestApproval", native: { threadId, turnId: "turn-1", itemId: "exec-1" } },
  });
  expect(session.records().some((record) => record.kind === "response" && record.requestId === "srv-7")).toBe(false);
  await session.dispose();
});

test("an unrequested app-server exit is recorded as an exit pointing at no request", async () => {
  const fake = scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work" });
  const held = await session.prompt("hold");
  fake.end(2);
  expect(await awaitTurnEnd(session, held.request.seq)).toEqual({ kind: "failed", reason: "runtime exited", failure: "runtime_exited" });
  const exit = session.records().at(-1);
  expect(exit).toMatchObject({ kind: "response", requestId: "", body: { kind: "exited", code: 2 } });
  const after = await session.prompt("after");
  expect(after.response.body).toEqual({ kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
});


test("an interrupt pending at exit is runtime_exited, not a native refusal", async () => {
  const fake = scriptedAppServer({ interruptHangs: true });
  const session = await codexSession(installation, { cwd: "/work" });
  const prompt = await session.prompt("hold");
  const abort = session.abort();
  fake.end(9);
  const result = await abort;
  expect(result.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  expect(session.records().filter((record) => record.kind === "response" && record.requestId === result.request.id)).toHaveLength(1);
  expect(await awaitTurnEnd(session, prompt.request.seq)).toMatchObject({ failure: "runtime_exited" });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Assert the deadline and its recorded outcome on the same active turn.
test.each([false, true])("a stuck aborted turn is killed even when interrupt was acknowledged: %s", async (acknowledge) => {
  vi.useFakeTimers();
  const fake = scriptedAppServer({ interruptHangs: !acknowledge, interruptAckOnly: acknowledge });
  const session = await codexSession(installation, { cwd: "/work" });
  const prompt = await session.prompt("hold");
  const liveEnd = awaitTurnEnd(session, prompt.request.seq);
  const abort = session.abort();
  await vi.advanceTimersByTimeAsync(5000);
  const repeated = session.abort();
  await vi.advanceTimersByTimeAsync(4999);
  expect(fake.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.killed()).toBe(true);
  const result = await abort;
  await repeated;
  expect(result.response.body).toMatchObject({ kind: "accepted" });
  expect(session.records().filter((record) => record.kind === "response" && record.requestId === result.request.id)).toHaveLength(1);
  expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(true);
  expect(await liveEnd).toMatchInlineSnapshot(`
    {
      "kind": "aborted",
    }
  `);
  expect(await awaitTurnEnd(session, prompt.request.seq)).toMatchInlineSnapshot(`
    {
      "kind": "aborted",
    }
  `);
  await session.dispose();
});


// oxlint-disable-next-line eslint/max-statements -- Pin timer cancellation across two successive turns.
test("a completed turn cancels the abort deadline before another turn starts", async () => {
  vi.useFakeTimers();
  const fake = scriptedAppServer({ interruptAckOnly: true });
  const session = await codexSession(installation, { cwd: "/work" });
  await session.prompt("hold");
  await session.abort();
  notify(fake, "turn/completed", { threadId, turn: { id: "turn-1", status: "interrupted" } });
  await session.prompt("hold");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fake.killed()).toBe(false);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Follow native adoption, child isolation and settlement through one adapter stream.
test("native Codex activity adopts a turn, while child activity does not start the root", async () => {
  const fake = scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work" });
  notify(fake, "turn/started", { threadId: "child", turn: { id: "child-turn" } });
  expect(session.status().value).toEqual({ kind: "idle" });
  notify(fake, "turn/started", { threadId, turn: { id: "native-turn" } });
  const record = session.records().at(-1);
  expect(session.status().value).toEqual({ kind: "running", phase: "waiting_model", sinceSeq: record?.seq, lastEventAt: record?.receivedAt });
  expect(session.records().filter((item) => item.kind === "request")).toHaveLength(0);
  expect(viewOf(session.records(), session.id).messages.filter((item) => item.kind === "turn")).toHaveLength(1);
  notify(fake, "turn/completed", { threadId, turn: { id: "native-turn", status: "completed" } });
  expect(session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" } });
  await session.dispose();
});
