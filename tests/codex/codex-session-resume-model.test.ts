import { afterEach, expect, test, vi } from "vitest";
import { promptAndWait } from "../../packages/oar/src/index.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.153.4" } as const;
const threadId = "thread-123";

afterEach(() => {
  spawnLineProcess.mockReset();
});

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * A scripted app-server: answers initialize with `{}` and thread/start or
 * thread/resume with the thread id plus whatever model `activeModel` says is
 * really running. Records every request so tests can assert the wire shape.
 */
function fakeAppServer(activeModel: (request: Request) => string): { fake: FakeLineProcess; requests: Request[] } {
  const requests: Request[] = [];
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    const request: Request = { id: message.id, method: message.method, params: asRecord(message.params) ?? {} };
    requests.push(request);
    const result = request.method === "initialize"
      ? {}
      : { thread: { id: threadId }, model: activeModel(request), modelProvider: "openai" };
    process.emit(`${JSON.stringify({ id: request.id, result })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return { fake, requests };
}

test("thread/resume carries the requested model and the session resumes the same id", async () => {
  const { fake, requests } = fakeAppServer((request) => String(request.params.model));
  const session = await codexSession(installation, { cwd: "/work", resume: threadId, model: "gpt-5.5" });
  expect(session.id).toBe(threadId);
  const resume = requests.find((request) => request.method === "thread/resume");
  expect(resume?.params).toMatchObject({ threadId, cwd: "/work", model: "gpt-5.5", approvalPolicy: "never" });
  await session.dispose();
  expect(fake.killed()).toBe(true);
});

test("thread/resume without a model does not send one", async () => {
  const { requests } = fakeAppServer(() => "whatever-was-saved");
  const session = await codexSession(installation, { cwd: "/work", resume: threadId });
  const resume = requests.find((request) => request.method === "thread/resume");
  expect(resume?.params).not.toHaveProperty("model");
  await session.dispose();
});

// The case the owner asked tests to catch: the runtime accepts the request
// but keeps the old model (codex logs "thread/resume overrides ignored for
// loaded thread" and answers with the old model). An adapter that only
// forwards the parameter would resolve here; ours must reject.
test("resume that silently keeps the old model is rejected", async () => {
  const { fake } = fakeAppServer(() => "gpt-5.4-mini");
  await expect(codexSession(installation, { cwd: "/work", resume: threadId, model: "gpt-5.5" })).rejects.toThrow(
    "codex thread/resume kept model gpt-5.4-mini although gpt-5.5 was requested",
  );
  expect(fake.killed()).toBe(true);
});

test("thread/start that reports a different model is rejected too", async () => {
  fakeAppServer(() => "gpt-5.4-mini");
  await expect(codexSession(installation, { cwd: "/work", model: "gpt-5.5" })).rejects.toThrow(
    "codex thread/start kept model gpt-5.4-mini although gpt-5.5 was requested",
  );
});

// Session.model is the response `model`, so a resume without a request still
// reads back what the thread really runs, and a matching request reads back
// the runtime's spelling rather than ours.
test("Session.model reads back the model the app-server answered with", async () => {
  fakeAppServer(() => "gpt-5.4-mini");
  const resumed = await codexSession(installation, { cwd: "/work", resume: threadId });
  expect(resumed.model().value).toBe("gpt-5.4-mini");
  await resumed.dispose();

  fakeAppServer(() => "gpt-5.5");
  const started = await codexSession(installation, { cwd: "/work", model: "gpt-5.5" });
  expect(started.model().value).toBe("gpt-5.5");
  await started.dispose();
});

test("Session.model is null when the app-server answer carries no model", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number") {
      return;
    }
    const result = message.method === "initialize" ? {} : { thread: { id: threadId } };
    process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  expect(session.model().value).toBeNull();
  await session.dispose();
});

// A refused resume names the method ("no rollout found for thread id …"
// alone would not tell a caller that resume was the thing that failed), and
// the app-server started for it does not outlive the failure.
test("a thread/resume the app-server refuses rejects naming thread/resume and kills the child", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    if (message.method === "initialize") {
      process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      return;
    }
    process.emit(`${JSON.stringify({ id: message.id, error: { message: "no rollout found for thread id thread-123" } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(codexSession(installation, { cwd: "/work", resume: threadId })).rejects.toThrow(
    "codex thread/resume failed: no rollout found for thread id thread-123",
  );
  expect(fake.killed()).toBe(true);
});

const usage = (input: number, output: number): Record<string, unknown> => ({ total: { inputTokens: input, outputTokens: output } });

/** An app-server's answer to one request: the reply's result, then the notifications it sends. */
interface Answer {
  readonly result: Record<string, unknown>;
  readonly notifications: readonly (readonly [string, Record<string, unknown>])[];
}

/**
 * An app-server resuming a thread that ran one turn before (thread total
 * 1000 / 5): right after the reply it re-reports that total under the old
 * turn's id ([env] codex 0.151.0 and later; `rereport` false: as before
 * 0.151.0, it does not), and a prompt's turn adds 1200 / 7.
 */
const resumedThread = (rereport: boolean): ReadonlyMap<string, Answer> => new Map<string, Answer>([
  ["initialize", { result: {}, notifications: [] }],
  ["thread/resume", {
    result: { thread: { id: threadId }, model: "gpt-5.5" },
    notifications: rereport ? [["thread/tokenUsage/updated", { turnId: "turn-1", tokenUsage: usage(1000, 5) }]] : [],
  }],
  ["turn/start", {
    result: { turn: { id: "turn-2" } },
    notifications: [
      ["turn/started", { turn: { id: "turn-2" } }],
      ["thread/tokenUsage/updated", { turnId: "turn-2", tokenUsage: usage(2200, 12) }],
      ["turn/completed", { turn: { id: "turn-2", status: "completed" } }],
    ],
  }],
]);

function resumedThreadWithHistory(rereport: boolean): void {
  const answers = resumedThread(rereport);
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    const answer = typeof message?.method === "string" ? answers.get(message.method) : undefined;
    if (typeof message?.id !== "number" || answer === undefined) {
      return;
    }
    process.emit(`${JSON.stringify({ id: message.id, result: answer.result })}\n`);
    for (const [method, params] of answer.notifications) {
      process.emit(`${JSON.stringify({ method, params: { threadId, ...params } })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
}

// #169: usage() is THIS Session's, so a resumed Session subtracts the total
// codex re-reported before its first turn.
test("a resumed Session's usage counts from when it opened", async () => {
  resumedThreadWithHistory(true);
  const session = await codexSession(installation, { cwd: "/work", resume: threadId });
  await promptAndWait(session, "again");
  expect(session.usage().value).toEqual({ total: { input: 1200, output: 7 } });
  await session.dispose();
});

// Without the re-report this Session's share is unknown: no total, never
// the thread's lifetime figure.
test("a resumed Session without codex's re-report has no usage total", async () => {
  resumedThreadWithHistory(false);
  const session = await codexSession(installation, { cwd: "/work", resume: threadId });
  await promptAndWait(session, "again");
  expect(session.usage().value).toEqual({ total: null });
  await session.dispose();
});
