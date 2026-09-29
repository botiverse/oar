import { setImmediate as nextTick } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { claudeAsk } from "../../packages/oar/src/runtimes/claude/approvals.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.284" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

// The can_use_tool claude 2.1.284 wrote for a Bash `touch` (experiments/approval-channels.ts), paths shortened.
const INPUT = { command: "touch /work/probe", description: "create the probe file" };
const BASH_REQUEST = {
  type: "control_request",
  request_id: "perm-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    display_name: "Bash",
    input: INPUT,
    description: "create the probe file",
    permission_suggestions: [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch /work/probe" }], behavior: "allow", destination: "localSettings" },
      { type: "addDirectories", directories: ["/work"], destination: "session" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
    blocked_path: "/work/probe",
    tool_use_id: "toolu_1",
  },
};

const QUESTIONS = [
  { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
  { question: "Which sizes?", header: "Sizes", multiSelect: true, options: [{ label: "Small" }, { label: "Large" }] },
];
const QUESTION_REQUEST = {
  type: "control_request",
  request_id: "perm-2",
  request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", display_name: "AskUserQuestion", input: { questions: QUESTIONS }, tool_use_id: "toolu_2", requires_user_interaction: true },
};

async function askSession(): Promise<{ fake: FakeLineProcess; session: Awaited<ReturnType<typeof claudeSession>> }> {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work", approvals: "ask" });
  return { fake, session };
}

function describe(record: RawEvent): string {
  switch (record.kind) {
    case "request":
      return `${record.direction} ${record.body.kind === "native" ? record.body.type : record.body.kind}`;
    case "response":
      return `response ${record.body.kind}${record.body.kind === "rejected" ? `:${record.body.code}` : ""}`;
    case "frame":
      return `frame ${record.body.type}${record.body.events.length === 0 ? "" : ` → ${record.body.events.map((event) => event.kind).join(",")}`}`;
    default:
      return "?";
  }
}

function writtenReplies(fake: FakeLineProcess): unknown[] {
  return fake.written.map((text) => asRecord(parseJson(text))).filter((message) => message?.type === "control_response").map((message) => asRecord(message?.response)?.response);
}

function askOf(record: RawEvent | undefined): unknown {
  return record?.kind === "request" && record.body.kind === "native" ? record.body.ask : null;
}

function canUseTool(fields: JsonRecord): JsonRecord {
  return { type: "control_request", request_id: "x", request: { subtype: "can_use_tool", ...fields } };
}

test("approvals decide the permission flags: YOLO skips the gate, ask forces claude's gate on and routes it to stdio", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess());
  const yolo = await claudeSession(installation, { cwd: "/work" });
  const { session: ask } = await askSession();
  const [yoloArgs, askArgs] = spawnLineProcess.mock.calls.map((call) => call[1]);
  expect(yoloArgs).toContain("--dangerously-skip-permissions");
  expect(askArgs).not.toContain("--dangerously-skip-permissions");
  expect(askArgs).toEqual(expect.arrayContaining(["--permission-mode", "default", "--permission-prompt-tool", "stdio"]));
  expect([yolo.capabilities.approvals, ask.capabilities.approvals]).toEqual([{ kind: "supported" }, { kind: "supported" }]);
  await Promise.all([yolo.dispose(), ask.dispose()]);
});

test("a can_use_tool line is one record, the toApp request, with what it asks", async () => {
  const { fake, session } = await askSession();
  fake.emit(line(BASH_REQUEST));
  await nextTick();
  expect(session.records().map((record) => describe(record))).toEqual(["toApp can_use_tool"]);
  expect(askOf(session.records()[0])).toEqual({
    kind: "tool_approval",
    tool: "Bash",
    callId: "toolu_1",
    title: "create the probe file",
    input: JSON.stringify(INPUT),
    command: "touch /work/probe",
    paths: ["/work/probe"],
    choices: ["allow", "allow_session", "deny"],
    denyMessage: true,
  });
  await session.dispose();
});

test("each decision is the control_response claude takes, written to stdin and recorded as sent", async () => {
  const { fake, session } = await askSession();
  for (const id of ["a", "b", "c", "d"]) {
    fake.emit(line({ ...BASH_REQUEST, request_id: id }));
  }
  await nextTick();
  const outcomes = await Promise.all([
    session.answer("a", { kind: "allow" }),
    session.answer("b", { kind: "allow", scope: "session" }),
    session.answer("c", { kind: "deny" }),
    session.answer("d", { kind: "deny", message: "use pnpm" }),
  ]);
  expect(outcomes.map((outcome) => outcome.kind)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
  // A session grant is claude's own rule and directory suggestions, kept to the session; never its mode switch.
  expect(writtenReplies(fake)).toEqual([
    { behavior: "allow", updatedInput: INPUT },
    {
      behavior: "allow",
      updatedInput: INPUT,
      updatedPermissions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch /work/probe" }], behavior: "allow", destination: "session" },
        { type: "addDirectories", directories: ["/work"], destination: "session" },
      ],
    },
    { behavior: "deny", message: "The user denied this tool use." },
    { behavior: "deny", message: "use pnpm" },
  ]);
  const answered = session.records().find((record) => record.kind === "response" && record.requestId === "a");
  expect(answered?.kind === "response" ? answered.body : null).toEqual({ kind: "answered", native: parseJson(fake.written[0] ?? "null") });
  await session.dispose();
});

test("AskUserQuestion is a question; the answers go back as claude's own tool reads them", async () => {
  const { fake, session } = await askSession();
  fake.emit(line(QUESTION_REQUEST));
  await nextTick();
  expect(askOf(session.records()[0])).toEqual({
    kind: "question",
    questions: [
      { id: "Which color?", question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false, other: true },
      { id: "Which sizes?", question: "Which sizes?", header: "Sizes", options: [{ label: "Small" }, { label: "Large" }], multiSelect: true, other: true },
    ],
    choices: ["answer", "deny"],
    denyMessage: true,
  });
  const refused = await session.answer("perm-2", { kind: "allow" });
  const answered = await session.answer("perm-2", { kind: "answer", answers: { "Which color?": "Blue", "Which sizes?": ["Small", "Large"] } });
  expect([refused.kind === "rejected" ? refused.code : refused.kind, answered.kind]).toEqual(["unsupported", "accepted"]);
  expect(asRecord(writtenReplies(fake)[0])?.updatedInput).toEqual({ questions: QUESTIONS, answers: { "Which color?": "Blue", "Which sizes?": "Small, Large" } });
  await session.dispose();
});

test("claude withdrawing a request (an interrupted turn) settles it: a later answer is rejected, nothing written", async () => {
  const { fake, session } = await askSession();
  fake.emit(line(BASH_REQUEST));
  fake.emit(line({ type: "control_cancel_request", request_id: "perm-1" }));
  await nextTick();
  expect(session.records().map((record) => describe(record))).toEqual(["toApp can_use_tool", "frame control_cancel_request → app_request_withdrawn"]);
  const late = await session.answer("perm-1", { kind: "allow" });
  expect(late.kind === "rejected" ? late.code : late.kind).toBe("withdrawn");
  expect(writtenReplies(fake)).toEqual([]);
  await session.dispose();
});

test("an exit voids a pending request: status stops awaiting and an answer is rejected runtime_exited", async () => {
  const { fake, session } = await askSession();
  await session.prompt("go");
  fake.emit(line(BASH_REQUEST));
  await nextTick();
  expect(session.status().value.awaiting).toEqual(["perm-1"]);
  fake.end(null);
  expect(session.status().value.awaiting).toBeUndefined();
  const answer = await session.answer("perm-1", { kind: "allow" });
  expect(answer.kind === "rejected" ? answer.code : answer.kind).toBe("runtime_exited");
  await session.dispose();
});

test("claudeAsk: no remembered grant where claude suggests no rule or suppresses it; file tools name their path", () => {
  const asks = [
    claudeAsk(canUseTool({ tool_name: "Bash", input: { command: "ls" } })),
    claudeAsk(canUseTool({ ...BASH_REQUEST.request, suppress_always_allow_rule: true })),
    claudeAsk(canUseTool({ tool_name: "Edit", input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" }, tool_use_id: "t9" })),
    claudeAsk({ type: "control_request", request_id: "y", request: { subtype: "hook_callback" } }),
  ];
  expect(asks.map((ask) => (ask?.kind === "tool_approval" ? [ask.choices.join(","), ask.command, ask.paths] : ask))).toEqual([
    ["allow,deny", "ls", undefined],
    ["allow,deny", "touch /work/probe", ["/work/probe"]],
    ["allow,deny", undefined, ["/work/a.ts"]],
    undefined,
  ]);
});
