import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { refuseManagedLaunchArgs } from "../../packages/oar/src/runtimes/claude/launch-args.js";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { claudeAbortRequested, foldClaudeStdout, initialClaudeProjection, type ClaudeProjectionState } from "../../packages/oar/src/runtimes/claude/projection.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

const installation = { kind: "available", via: "executable", command: "claude" } as const;

async function argsFor(options: Partial<SessionOptions>): Promise<readonly string[]> {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  await launchClaude("claude", "new-id", { cwd: "/work", ...options });
  child.kill();
  return spawnLineProcess.mock.calls[0]?.[1] ?? [];
}

// [env] claude 2.1.323: the copy runs under the --session-id given with --fork-session,
// and --resume-session-at cuts it after that assistant message.
test("a fork resumes the source with --fork-session under OAR's new id, cut with --resume-session-at", async () => {
  const args = await argsFor({ resume: "source", fork: { through: "assistant-uuid" } });
  expect(args).toEqual(expect.arrayContaining(["--resume", "source", "--fork-session", "--session-id", "new-id", "--resume-session-at=assistant-uuid"]));
  expect(args.indexOf("--fork-session")).toBe(args.indexOf("--resume") + 2);
});

test("a fork without through copies the whole conversation", async () => {
  const args = await argsFor({ resume: "source", fork: {} });
  expect(args).toEqual(expect.arrayContaining(["--resume", "source", "--fork-session", "--session-id", "new-id"]));
  expect(args.some((arg) => arg.startsWith("--resume-session-at"))).toBe(false);
});

test("a resume and a new session launch as before", async () => {
  const resumed = await argsFor({ resume: "new-id" });
  expect(resumed).toEqual(expect.arrayContaining(["--resume", "new-id"]));
  expect(resumed).not.toContain("--fork-session");
  expect(resumed).not.toContain("--session-id");
  spawnLineProcess.mockReset();
  const fresh = await argsFor({});
  expect(fresh).toEqual(expect.arrayContaining(["--session-id", "new-id"]));
  expect(fresh).not.toContain("--resume");
});

test("a fork is a new session, so it takes --name; a plain resume still does not", async () => {
  expect(await argsFor({ resume: "source", fork: {}, name: "Branch" })).toEqual(expect.arrayContaining(["--name", "Branch"]));
  spawnLineProcess.mockReset();
  expect(await argsFor({ resume: "source", name: "Branch" })).not.toContain("--name");
});

test("--fork-session stays refused in launchArgs, pointing at SessionOptions.fork", () => {
  expect(() => { refuseManagedLaunchArgs(["--fork-session"]); }).toThrow(/claude launchArgs cannot include --fork-session: use SessionOptions\.fork with resume/u);
});

test("--resume-session-at in launchArgs is refused with a fork, and passes without one as before", async () => {
  await expect(launchClaude("claude", "new-id", { cwd: "/work", resume: "source", fork: { through: "a" }, launchArgs: ["--resume-session-at", "b"] }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "launchArgs", message: "claude launchArgs cannot include --resume-session-at with SessionOptions.fork: use fork.through" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
  // A resume launches under its own id, which claudeSession passes as the session id.
  expect(await argsFor({ resume: "new-id", launchArgs: ["--resume-session-at", "b"] })).toEqual(expect.arrayContaining(["--resume", "new-id", "--resume-session-at", "b"]));
});

test.each([
  [{ fork: {} }, "fork copies the saved session resume names; give resume with the source session id"],
  [{ resume: "source", fork: { through: " " } }, "fork.through must not be blank or contain NUL characters"],
  [{ resume: "source", fork: { through: "a\0b" } }, "fork.through must not be blank or contain NUL characters"],
])("an invalid fork is refused before claude starts: %j", async (options, message) => {
  const opening = launchClaude("claude", "new-id", { cwd: "/work", ...options });
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({ option: "fork", message });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

/** The control request subtype a stdin line carries. */
function subtypeOf(line: string): unknown {
  const request = asRecord(JSON.parse(line));
  return asRecord(request?.request)?.subtype;
}

/**
 * A claude that answers every control request; `get_status` reports `reported`
 * (default: the --session-id it was launched with) as its Session ID row,
 * beside the account rows that make the answer private.
 */
function forkedClaude(reported?: string | null): FakeLineProcess {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    const subtype = asRecord(request?.request)?.subtype;
    const args = spawnLineProcess.mock.calls[0]?.[1] ?? [];
    const id = reported === undefined ? args[args.indexOf("--session-id") + 1] : reported;
    const status = { sections: [{ title: "Session", rows: [{ label: "Version", value: "2.1.323" }, ...(id === null ? [] : [{ label: "Session ID", value: id }]), { label: "Email", value: "user@example.com" }] }] };
    const answers: Record<string, object> = { get_usage: { session: { model_usage: {} } }, get_status: status };
    const response = typeof subtype === "string" ? answers[subtype] ?? {} : {};
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

test("the forked Session reports the new id it launched under, after claude's get_status confirms it, and keeps that answer private", async () => {
  const fake = forkedClaude();
  const session = await claudeSession(installation, { cwd: "/work", resume: "source", fork: { through: "assistant-uuid" } });
  const args = spawnLineProcess.mock.calls[0]?.[1] ?? [];
  expect(session.id).not.toBe("source");
  expect(args[args.indexOf("--session-id") + 1]).toBe(session.id);
  expect(fake.written.map(subtypeOf)).toEqual(["initialize", "get_status", "get_usage"]);
  expect(JSON.stringify(session.records())).not.toContain("user@example.com");
  await session.dispose();
});

test.each([
  ["another id", "source", "claude runs the fork as session source, not NEW as OAR assigned"],
  ["no id", null, "claude get_status reported no session id, so the fork's session id NEW cannot be confirmed"],
])("a fork whose claude reports %s fails the open and stops the process", async (_case, reported, message) => {
  const fake = forkedClaude(reported);
  const failure: unknown = await claudeSession(installation, { cwd: "/work", resume: "source", fork: {} }).catch((error: unknown) => error);
  const args = spawnLineProcess.mock.calls[0]?.[1] ?? [];
  const assigned = String(args[args.indexOf("--session-id") + 1]);
  expect(failure).toMatchObject({ message: message.replace("NEW", assigned) });
  expect(fake.killed()).toBe(true);
});

test("a plain resume sends no get_status", async () => {
  const fake = forkedClaude();
  const session = await claudeSession(installation, { cwd: "/work", resume: "existing" });
  expect(session.id).toBe("existing");
  expect(fake.written.map(subtypeOf)).toEqual(["initialize", "get_usage"]);
  await session.dispose();
});

function fold(frames: readonly JsonRecord[]): JsonRecord[] {
  let state: ClaudeProjectionState = initialClaudeProjection;
  const ended: JsonRecord[] = [];
  for (const frame of frames) {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    state = next;
    for (const command of commands) {
      if (command.kind === "frame") { ended.push(...command.body.events.filter((event) => event.kind === "turn_ended")); }
    }
  }
  return ended;
}

const assistant = (uuid: string, parent: string | null = null): JsonRecord => ({ type: "assistant", uuid, parent_tool_use_id: parent, message: { id: `msg-${uuid}`, role: "assistant", content: [{ type: "text", text: uuid }] } });
const result = (parent: string | null = null): JsonRecord => ({ type: "result", subtype: "success", is_error: false, parent_tool_use_id: parent, usage: {} });

test("a root turn's end carries the uuid of its last root assistant message as the fork anchor", () => {
  const ended = fold([
    { type: "system", subtype: "init", session_id: "s" },
    assistant("a-1"), assistant("a-2"), assistant("child", "task-1"), result(),
    // A turn with no assistant message names no anchor, never the previous turn's.
    { type: "system", subtype: "init", session_id: "s" },
    result(),
  ]);
  expect(ended.map((event) => [event.kind, event.forkAnchor])).toEqual([["turn_ended", "a-2"], ["turn_ended", undefined]]);
  expect(ended[1]).not.toHaveProperty("forkAnchor");
});

test("a failed turn's synthetic error message is its anchor; an aborted turn names none", () => {
  const failed = fold([{ type: "system", subtype: "init", session_id: "s" }, assistant("api-error"), { ...result(), is_error: true, result: "API Error: 400 boom" }]);
  expect(failed.map((event) => [asRecord(event.outcome)?.kind, event.forkAnchor])).toEqual([["failed", "api-error"]]);
  const state = claudeAbortRequested(foldClaudeStdout(foldClaudeStdout(initialClaudeProjection, { type: "system", subtype: "init", session_id: "s" }).state, assistant("tool-use")).state);
  const { commands } = foldClaudeStdout(state, result());
  const ended = commands.flatMap((command) => command.kind === "frame" ? command.body.events.filter((event) => event.kind === "turn_ended") : []);
  expect(ended).toEqual([expect.objectContaining({ outcome: { kind: "aborted" } })]);
  expect(ended[0]).not.toHaveProperty("forkAnchor");
});

const toolUse = (uuid: string, name: string): JsonRecord => ({ type: "assistant", uuid, parent_tool_use_id: null, message: { id: `msg-${uuid}`, role: "assistant", content: [{ type: "tool_use", id: `call-${uuid}`, name, input: {} }] } });
const toolResult = (uuid: string, call: string, parent: string | null = null): JsonRecord => ({ type: "user", uuid, parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: "done" }] } });

// [env] claude 2.1.323 (sea-trial/vendor/session-fork-cases.vendor.test.ts): a fork through a
// tool_use drops its saved tool_result, so such a turn names no anchor.
test.each([
  ["an outputSchema turn completed on its StructuredOutput call", [toolUse("so", "StructuredOutput"), toolResult("so-result", "call-so"), { ...result(), stop_reason: "tool_use", structured_output: { answer: 4 } }], "completed"],
  ["an error_max_turns turn failed after a tool call", [toolUse("bash", "Bash"), toolResult("bash-result", "call-bash"), { ...result(), subtype: "error_max_turns", is_error: true }], "failed"],
  ["an error_max_structured_output_retries turn", [toolUse("so", "StructuredOutput"), toolResult("so-result", "call-so"), { ...result(), subtype: "error_max_structured_output_retries", is_error: true }], "failed"],
])("%s names no anchor", (_case, frames, kind) => {
  const ended = fold([{ type: "system", subtype: "init", session_id: "s" }, assistant("text-before"), ...frames]);
  expect(ended.map((event) => asRecord(event.outcome)?.kind)).toEqual([kind]);
  expect(ended[0]).not.toHaveProperty("forkAnchor");
});

test("a turn that ends on text after its tool round is anchored on that text; a root tool_result after text clears it; a subagent's does not", () => {
  const ended = fold([
    { type: "system", subtype: "init", session_id: "s" },
    toolUse("bash", "Bash"), toolResult("bash-result", "call-bash"), assistant("after-tools"), result(),
    { type: "system", subtype: "init", session_id: "s" },
    assistant("text"), toolResult("late-result", "call-x"), result(),
    { type: "system", subtype: "init", session_id: "s" },
    assistant("root-text"), toolResult("child-result", "call-y", "task-1"), result(),
  ]);
  expect(ended.map((event) => event.forkAnchor)).toEqual(["after-tools", undefined, "root-text"]);
});
