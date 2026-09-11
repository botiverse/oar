import { afterEach, expect, test, vi } from "vitest";
import type { ControlResult, ResponseBody, SessionRecord } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.153.4" } as const;
const threadId = "thread-123";

afterEach(() => {
  spawnLineProcess.mockReset();
});

function notify(process: FakeLineProcess, method: string, params: Record<string, unknown>): void {
  process.emit(`${JSON.stringify({ method, params })}\n`);
}

/** turn/start: reply, start turn-1, and — unless the prompt is "hold" — stream a delta and complete; "ask" first sends a SERVER request (an approval). */
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
function scriptedAppServer(options: { interruptFails?: boolean } = {}): FakeLineProcess {
  let ended = false;
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (!ended && typeof message?.id === "number" && typeof message.method === "string") {
      answer(process, { id: message.id, method: message.method, params: asRecord(message.params) ?? {} }, options.interruptFails === true);
    }
  });
  fake.onExit(() => {
    ended = true;
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

function skeleton(records: readonly SessionRecord[]): string[] {
  return records.map((record) => {
    switch (record.kind) {
      case "request":
        return `${record.direction} ${record.body.kind}${record.body.kind === "native" ? `:${record.body.type}` : ""}`;
      case "response":
        return `response ${record.body.kind}`;
      case "event":
        return `event ${record.body.type}${record.spanId === undefined ? "" : ` span=${record.spanId}`}${record.body.views.length === 0 ? "" : ` → ${record.body.views.map((view) => view.kind).join(",")}`}`;
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
  expect(session.model()).toBe("gpt-5.5");
  await session.dispose();
  expect(skeleton(session.records())).toEqual([
    "event thread/start → model",
    "toRuntime prompt",
    "response accepted",
    "event turn/started span=turn-1",
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

test("busy while a turn runs; steer, queue and abort answer through the RPC replies", async () => {
  scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work" });
  const held = await session.prompt("hold");
  expect(held.response.body.kind).toBe("accepted");
  expect(await bodiesOf([session.prompt("again"), session.steer("more"), session.queue("later"), session.abort()])).toEqual([
    { kind: "rejected", reason: "busy" },
    { kind: "accepted", native: { turnId: "turn-1" } },
    { kind: "accepted", native: { submissionId: "sub-9" } },
    { kind: "accepted", native: {} },
  ]);
  expect(await awaitTurnEnd(session, held.request.seq)).toEqual({ kind: "aborted" });
  expect(await bodiesOf([session.abort(), session.steer("late")])).toEqual([
    { kind: "rejected", reason: "no active turn" },
    { kind: "rejected", reason: "not_steerable: no active turn" },
  ]);
  await session.dispose();
  expect(await bodiesOf([session.prompt("dead")])).toEqual([{ kind: "rejected", reason: "session disposed" }]);
});

test("an interrupt the runtime refuses is a rejected abort, not an error", async () => {
  scriptedAppServer({ interruptFails: true });
  const session = await codexSession(installation, { cwd: "/work" });
  await session.prompt("hold");
  const aborted = await session.abort();
  expect(aborted.response.body).toEqual({ kind: "rejected", reason: "turn already finished" });
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
  expect(after.response.body).toEqual({ kind: "rejected", reason: "app-server exited" });
});
