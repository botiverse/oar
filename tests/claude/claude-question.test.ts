/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- follow the native request, the reply and the records together. */
import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.309" } as const;
const QUESTION = { type: "control_request", request_id: "q-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion",
  input: { questions: [{ question: "Which?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] },
  requires_user_interaction: true } };

function replyOf(child: ReturnType<typeof fakeLineProcess>, requestId: string): unknown {
  const line = child.written.find((written) => written.includes(`"request_id":"${requestId}"`));
  return line === undefined ? undefined : JSON.parse(line);
}

test("questions: ask opens claude's gate, records the question and answers only it", async () => {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work", questions: "ask" });
  try {
    expect(spawnLineProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--permission-mode", "default", "--permission-prompt-tool", "stdio"]));
    expect("answer" in session).toBe(false);
    expect(session.capabilities.appRequests).toMatchObject({ kinds: [], questions: true });
    child.emit(`${JSON.stringify(QUESTION)}\n`);
    await Promise.resolve();
    expect(session.records().find((record) => record.kind === "request" && record.direction === "toApp")).toMatchObject({ id: "q-1", body: { kind: "native", type: "can_use_tool" } });
    const answerQuestion = session.answerQuestion?.bind(session);
    if (answerQuestion === undefined) { throw new Error("the session has no answerQuestion"); }
    const outcome = await answerQuestion("q-1", { answers: { "Which?": "Blue" } });
    expect(outcome).toMatchObject({ kind: "unconfirmed", answers: { answers: { "Which?": "Blue" } } });
    expect(replyOf(child, "q-1")).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: "q-1",
      response: { behavior: "allow", updatedInput: { answers: { "Which?": "Blue" } } } } });
    expect(session.records().find((record) => record.kind === "response" && record.requestId === "q-1")?.body).toMatchObject({ kind: "answered", by: "host" });
  } finally { await session.dispose(); }
});

test("a tool approval the gate also routes is denied and recorded, never granted", async () => {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work", questions: "ask" });
  try {
    child.emit(`${JSON.stringify({ type: "control_request", request_id: "a-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo probe" }, tool_use_id: "tool-1" } })}\n`);
    await Promise.resolve();
    expect(replyOf(child, "a-1")).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: "a-1", response: { behavior: "deny" } } });
    expect(session.records().find((record) => record.kind === "response" && record.requestId === "a-1")?.body).toMatchObject({ kind: "answered" });
    const answerQuestion = session.answerQuestion?.bind(session);
    if (answerQuestion === undefined) { throw new Error("the session has no answerQuestion"); }
    await expect(answerQuestion("a-1", { answers: { "Which?": "Blue" } })).resolves.toMatchObject({ kind: "rejected", code: "already_answered" });
  } finally { await session.dispose(); }
});

test("a question the runtime withdrew cannot be answered later", async () => {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work", questions: "ask" });
  try {
    child.emit(`${JSON.stringify(QUESTION)}\n`);
    child.emit(`${JSON.stringify({ type: "control_cancel_request", request_id: "q-1" })}\n`);
    await Promise.resolve();
    const answerQuestion = session.answerQuestion?.bind(session);
    if (answerQuestion === undefined) { throw new Error("the session has no answerQuestion"); }
    await expect(answerQuestion("q-1", { answers: { "Which?": "Blue" } })).resolves.toMatchObject({ kind: "aborted", code: "cancelled" });
  } finally { await session.dispose(); }
});

test("questions: ask refuses a host permission flag it would contradict", async () => {
  await expect(claudeSession(installation, { cwd: "/work", questions: "ask", launchArgs: ["--permission-mode", "plan"] }))
    .rejects.toBeInstanceOf(UnsupportedOptionError);
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
