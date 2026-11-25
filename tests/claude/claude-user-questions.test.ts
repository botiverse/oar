/* oxlint-disable max-statements -- Each test keeps the request, the wire reply and the records together. */
import { afterEach, expect, test, vi } from "vitest";
import { eventsOf } from "../../packages/oar/src/observe/index.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.332" } as const;
const INPUT = { questions: [
  { question: "Which color?", header: "Color", options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }], multiSelect: false },
  { question: "Which sizes?", header: "Size", options: [{ label: "S", description: "s" }, { label: "M", description: "m" }], multiSelect: true },
] };
const HOST = { userQuestions: "host" } as const;
const QUESTION = { toolName: "AskUserQuestion", input: INPUT } as const;

async function open(options: Omit<SessionOptions, "cwd"> = HOST): Promise<{ readonly child: FakeLineProcess; readonly session: Session; readonly args: readonly string[] }> {
  const child = fakeLineProcess();
  let args: readonly string[] = [];
  spawnLineProcess.mockImplementation((_command: string, given: readonly string[]) => { args = given; return child; });
  const session = await claudeSession(installation, { cwd: "/work", ...options });
  return { child, session, args };
}
function ask(child: FakeLineProcess, id: string, { toolName, input }: { readonly toolName: string; readonly input: unknown } = QUESTION): void {
  child.emit(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: "call" } })}\n`);
}
const replies = (child: FakeLineProcess): unknown[] => child.written.map((line) => asRecord(parseJson(line))).filter((message) => message?.type === "control_response");
const appEvents = (session: Session): string[] => session.records().flatMap((record) => eventsOf(record)).map((event) => event.kind).filter((kind) => kind.startsWith("app_"));
const reply = (id: string, response: unknown): unknown => ({ type: "control_response", response: { subtype: "success", request_id: id, response } });

test("the option sends permission prompts to OAR, keeps bypass, and keeps plan mode out", async () => {
  const { session, args } = await open({ userQuestions: "host", disallowedTools: ["WebSearch"] });
  expect(args).toContain("--dangerously-skip-permissions");
  expect(args.slice(args.indexOf("--permission-prompt-tool")).slice(0, 2)).toEqual(["--permission-prompt-tool", "stdio"]);
  expect(args.slice(args.indexOf("--disallowed-tools"))).toEqual(["--disallowed-tools", "WebSearch", "EnterPlanMode", "ExitPlanMode"]);
  await session.dispose();
});

test("without the option nothing changes", async () => {
  const { session, args, child } = await open({});
  expect(args).not.toContain("--permission-prompt-tool");
  expect(args).not.toContain("--disallowed-tools");
  expect("answerQuestion" in session).toBe(false);
  ask(child, "q");
  expect(replies(child)).toEqual([]);
  await session.dispose();
});

test("a question waits, then its answers go back inside the tool input", async () => {
  const { session, child } = await open();
  ask(child, "q");
  expect(replies(child)).toEqual([]);
  expect(viewOf(session.records()).pendingRequests).toMatchObject([{ requestId: "q" }]);
  const outcome = await session.answerQuestion?.("q", { kind: "answered", answers: { "Which color?": { text: "teal" }, "Which sizes?": { selected: ["S", "M"], text: "and L" } } });
  const expected = reply("q", { behavior: "allow", updatedInput: { ...INPUT, answers: { "Which color?": "teal", "Which sizes?": "S, M, and L" } } });
  expect(replies(child)).toEqual([expected]);
  expect(outcome).toMatchObject({ kind: "answered", requestId: "q", response: { requestId: "q", body: { kind: "answered", native: expected } } });
  expect(appEvents(session)).toEqual(["app_request", "app_answered"]);
  expect(viewOf(session.records()).pendingRequests).toEqual([]);
  expect(await session.answerQuestion?.("q", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "already_resolved" });
  await session.dispose();
});

test("declining denies the tool with the reason", async () => {
  const { session, child } = await open();
  ask(child, "a");
  ask(child, "b");
  await session.answerQuestion?.("a", { kind: "declined" });
  await session.answerQuestion?.("b", { kind: "declined", reason: "Ask me later." });
  expect(replies(child)).toEqual([reply("a", { behavior: "deny", message: "The user declined to answer." }), reply("b", { behavior: "deny", message: "Ask me later." })]);
  await session.dispose();
});

test("two choices on a single-select question are refused and write nothing", async () => {
  const { session, child } = await open();
  ask(child, "q");
  expect(await session.answerQuestion?.("q", { kind: "answered", answers: { "Which color?": { selected: ["Red", "Blue"] } } })).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(replies(child)).toEqual([]);
  await session.dispose();
});

test.each([["Bash", { command: "echo" }], ["ExitPlanMode", {}], ["AskUserQuestion", { questions: [] }]])("a permission request for %s is denied at once, never left hanging", async (tool, input) => {
  const { session, child } = await open();
  ask(child, "p", { toolName: tool, input });
  expect(replies(child)).toMatchObject([reply("p", { behavior: "deny" })]);
  expect(appEvents(session)).toEqual(["app_request", "app_answered"]);
  expect(await session.answerQuestion?.("p", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "unknown_request" });
  await session.dispose();
});

test("claude withdrawing a question closes it; an exit closes the rest", async () => {
  const { session, child } = await open();
  ask(child, "q");
  child.emit(`${JSON.stringify({ type: "control_cancel_request", request_id: "q" })}\n`);
  expect(appEvents(session)).toEqual(["app_request", "app_request_cancelled"]);
  expect(await session.answerQuestion?.("q", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "already_resolved" });
  ask(child, "r");
  child.end(1);
  expect(await session.answerQuestion?.("r", { kind: "declined" })).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  expect(replies(child)).toEqual([]);
});

test.each([["--permission-mode", "plan"], ["--permission-prompts=none"]])("%j cannot be combined with host questions", async (...launchArgs) => {
  await expect(open({ userQuestions: "host", launchArgs })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "userQuestions" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("an older or unreported claude refuses the option", async () => {
  for (const version of ["2.1.273", undefined]) {
    // oxlint-disable-next-line no-await-in-loop -- one open at a time keeps the failure attributable.
    await expect(claudeRuntime.session({ kind: "available", via: "executable", command: "claude", ...(version === undefined ? {} : { version }) }, { cwd: "/work", userQuestions: "host" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "userQuestions" });
  }
});
