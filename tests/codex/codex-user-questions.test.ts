/* oxlint-disable max-statements -- Each test keeps the request, the wire reply and the records together. */
import { expect, test, vi } from "vitest";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { codexRuntime } from "../../packages/oar/src/runtimes/codex/index.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex", version: "0.172.0" } as const;
const QUESTIONS = [
  { id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }] },
  { id: "key", header: "Key", question: "Your key?", isOther: true, isSecret: true, options: null },
];

interface Opened { readonly session: Session; readonly child: FakeLineProcess; readonly replies: JsonRecord[]; readonly args: readonly string[]; readonly ask: (id: number) => void }

async function open(host = true): Promise<Opened> {
  const replies: JsonRecord[] = [];
  let args: readonly string[] = [];
  const child = fakeLineProcess((line, fake) => {
    const message = asRecord(parseJson(line));
    if (message?.id === undefined) { return; }
    if (message.method === undefined) { replies.push(message); return; }
    fake.emit(`${JSON.stringify({ id: message.id, result: message.method === "thread/start" ? { thread: { id: "thread" } } : {} })}\n`);
  });
  spawnLineProcess.mockImplementation((_command: string, given: readonly string[]) => { args = given; return child; });
  const session = await codexSession(installation, { cwd: "/work", ...(host ? { userQuestions: "host" as const } : {}) });
  return { session, child, replies, args, ask: (id) => { child.emit(`${JSON.stringify({ id, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", itemId: "call", questions: QUESTIONS, isBlocking: false, autoResolutionMs: null } })}\n`); } };
}
const resolved = (child: FakeLineProcess, requestId: number): void => { child.emit(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread", requestId } })}\n`); };
const appEvents = (session: Session): string[] => session.records().flatMap((record) => eventsOf(record)).map((event) => event.kind).filter((kind) => kind.startsWith("app_"));

test("without the option a question is answered empty at once, as before", async () => {
  const { session, replies, args, ask } = await open(false);
  ask(0);
  expect(replies).toEqual([{ id: 0, result: { answers: {} } }]);
  expect("answerQuestion" in session).toBe(false);
  expect(args.join(" ")).not.toContain("default_mode_request_user_input");
  await session.dispose();
});

test("a question waits, its answer goes out in codex's words, and a secret is recorded redacted", async () => {
  const { session, replies, args, ask, child } = await open();
  expect(args.join(" ")).toContain("features.default_mode_request_user_input=true");
  ask(0);
  expect(replies).toEqual([]);
  expect(viewOf(session.records()).pendingRequests).toMatchObject([{ requestId: "0", type: "item/tool/requestUserInput" }]);
  const outcome = await session.answerQuestion?.("0", { kind: "answered", answers: { color: { selected: ["Blue"], text: "but dark" }, key: { text: "s3cret" } } });
  expect(outcome).toMatchObject({ kind: "answered", requestId: "0", response: { body: { kind: "answered", native: { result: { answers: { color: { answers: ["Blue", "user_note: but dark"] }, key: { answers: ["[redacted]"] } } } } } } });
  expect(replies).toEqual([{ id: 0, result: { answers: { color: { answers: ["Blue", "user_note: but dark"] }, key: { answers: ["user_note: s3cret"] } } } }]);
  expect(JSON.stringify(session.records())).not.toContain("s3cret");
  expect(JSON.stringify(outcome)).not.toContain("s3cret");
  resolved(child, 0);
  expect(appEvents(session)).toEqual(["app_request", "app_answered"]);
  expect(viewOf(session.records()).pendingRequests).toEqual([]);
  expect(await session.answerQuestion?.("0", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "already_resolved" });
  await session.dispose();
});

test("declining is codex's empty answer", async () => {
  const { session, replies, ask } = await open();
  ask(3);
  expect(await session.answerQuestion?.("3", { kind: "declined", reason: "not now" })).toMatchObject({ kind: "answered" });
  expect(replies).toEqual([{ id: 3, result: { answers: {} } }]);
  await session.dispose();
});

test.each([
  ["two choices", { color: { selected: ["Red", "Blue"] } }],
  ["a choice it does not offer", { color: { selected: ["Green"] } }],
  ["an id it did not ask", { size: { text: "M" } }],
])("%s is refused, writes nothing, and the question stays open", async (_name, answers) => {
  const { session, replies, ask } = await open();
  ask(0);
  const before = session.records().length;
  expect(await session.answerQuestion?.("0", { kind: "answered", answers })).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(await session.answerQuestion?.("9", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "unknown_request" });
  expect([replies, session.records().length]).toEqual([[], before]);
  expect(await session.answerQuestion?.("0", { kind: "answered", answers: { color: { selected: ["Red"] } } })).toMatchObject({ kind: "answered" });
  await session.dispose();
});

test("an empty text is no other words, so an options-only question takes it", async () => {
  const { session, replies, child } = await open();
  const question = { id: "color", question: "Which color?", isOther: false, options: [{ label: "Red" }, { label: "Blue" }] };
  child.emit(`${JSON.stringify({ id: 0, method: "item/tool/requestUserInput", params: { questions: [question] } })}\n`);
  expect(await session.answerQuestion?.("0", { kind: "answered", answers: { color: { selected: ["Red"], text: "teal" } } })).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(await session.answerQuestion?.("0", { kind: "answered", answers: { color: { selected: ["Red"], text: "" } } })).toMatchObject({ kind: "answered" });
  expect(replies).toEqual([{ id: 0, result: { answers: { color: { answers: ["Red"] } } } }]);
  await session.dispose();
});

test("two questions under one id are answered empty at once", async () => {
  const { session, replies, child } = await open();
  const question = { id: "color", question: "Which color?", options: null };
  child.emit(`${JSON.stringify({ id: 0, method: "item/tool/requestUserInput", params: { questions: [question, question] } })}\n`);
  expect(replies).toEqual([{ id: 0, result: { answers: {} } }]);
  expect(await session.answerQuestion?.("0", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "unknown_request" });
  await session.dispose();
});

test("a resolution without a request id withdraws nothing", async () => {
  const { session, child } = await open();
  child.emit(`${JSON.stringify({ id: "undefined", method: "item/tool/requestUserInput", params: { questions: QUESTIONS } })}\n`);
  expect(viewOf(session.records()).pendingRequests).toHaveLength(1);
  child.emit(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread" } })}\n`);
  expect(appEvents(session)).toEqual(["app_request"]);
  await session.dispose();
});

test("codex withdrawing a question cancels it", async () => {
  const { session, replies, ask, child } = await open();
  ask(0);
  resolved(child, 0);
  expect(appEvents(session)).toEqual(["app_request", "app_request_cancelled"]);
  expect(viewOf(session.records()).pendingRequests).toEqual([]);
  expect(await session.answerQuestion?.("0", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "already_resolved" });
  expect(replies).toEqual([]);
  await session.dispose();
});

test("an exit or dispose leaves nothing to answer", async () => {
  const exited = await open();
  exited.ask(0);
  exited.child.end(1);
  expect(viewOf(exited.session.records()).pendingRequests).toEqual([]);
  expect(await exited.session.answerQuestion?.("0", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  const disposed = await open();
  disposed.ask(0);
  await disposed.session.dispose();
  expect(await disposed.session.answerQuestion?.("0", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  expect(disposed.replies).toEqual([]);
});

test("an answer during dispose is refused as disposed", async () => {
  const { session, ask, replies } = await open();
  ask(0);
  const disposing = session.dispose();
  const answered = session.answerQuestion?.("0", { kind: "declined" });
  const outcome = await answered;
  expect(outcome?.kind === "rejected" ? outcome.code : outcome?.kind).toMatch(/^(?:disposed|runtime_exited)$/u);
  await disposing;
  expect(replies).toEqual([]);
});

test.each(["0.106.0", undefined])("version %s refuses the option before anything starts", async (version) => {
  spawnLineProcess.mockClear();
  await expect(codexRuntime.session({ kind: "available", via: "executable", command: "codex", ...(version === undefined ? {} : { version }) }, { cwd: "/work", userQuestions: "host" }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "userQuestions" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
