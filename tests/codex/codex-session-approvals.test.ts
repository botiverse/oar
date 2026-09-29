import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.155.1" } as const;
const threadId = "thread-1";

afterEach(() => {
  spawnLineProcess.mockReset();
});

function send(process: FakeLineProcess, message: JsonRecord): void {
  process.emit(`${JSON.stringify(message)}\n`);
}

/**
 * A scripted app-server: thread/start echoes the policy it was asked for
 * (or `openAs` overrides it), turn/start opens turn-1 and, for an input
 * naming a scenario, sends the server request codex 0.155.1 sent in
 * experiments/approval-channels.ts.
 */
/** What codex 0.155.1 sent for each scenario input (experiments/approval-channels.ts), after `turn/started`. */
const SCENARIOS: Readonly<Record<string, readonly JsonRecord[]>> = {
  command: [
    { method: "item/started", params: { threadId, turnId: "turn-1", item: { type: "commandExecution", id: "call_1", command: "/bin/zsh -lc 'touch x'", status: "inProgress" } } },
    { id: 7, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId, turnId: "turn-1", itemId: "call_1", command: "/bin/zsh -lc 'touch x'", cwd: "/work", availableDecisions: ["accept", "cancel"] } },
  ],
  patch: [
    { method: "item/started", params: { threadId, turnId: "turn-1", item: { type: "fileChange", id: "call_2", status: "inProgress", changes: [{ path: "/work/a.txt", kind: { type: "add" }, diff: "+hello\n" }] } } },
    { id: 8, method: "item/fileChange/requestApproval", params: { threadId, turnId: "turn-1", itemId: "call_2", reason: "write outside the workspace" } },
  ],
  question: [
    { id: 9, method: "item/tool/requestUserInput", params: { threadId, turnId: "turn-1", itemId: "call_3", isBlocking: true, questions: [{ id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "warm" }] }] } },
  ],
};

/** The lines codex answers a request with: its reply, then what it pushes. */
function reply(request: { readonly id: number; readonly method: string; readonly params: JsonRecord }, openAs: JsonRecord): readonly JsonRecord[] {
  const { id, method, params } = request;
  switch (method) {
    case "thread/start":
      return [{ id, result: { thread: { id: threadId }, model: "gpt-5.5", approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, ...openAs } }];
    case "turn/start": {
      const input = asRecord((Array.isArray(params.input) ? params.input : [])[0])?.text;
      return [{ id, result: { turn: { id: "turn-1" } } }, { method: "turn/started", params: { threadId, turn: { id: "turn-1" } } }, ...(SCENARIOS[String(input)] ?? [])];
    }
    case "turn/interrupt":
      return [
        { id, result: {} },
        { method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "interrupted" } } },
        { method: "serverRequest/resolved", params: { threadId, requestId: 7 } },
      ];
    default:
      return [{ id, result: {} }];
  }
}

/**
 * A scripted app-server: thread/start echoes the policy it was asked for
 * (or `openAs` overrides it), turn/start opens turn-1 and plays the
 * scenario its input names.
 */
function scriptedAppServer(openAs: JsonRecord = {}): FakeLineProcess {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(parseJson(text));
    if (typeof message?.id === "number" && typeof message.method === "string") {
      for (const out of reply({ id: message.id, method: message.method, params: asRecord(message.params) ?? {} }, openAs)) {
        send(process, out);
      }
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

function lines(fake: FakeLineProcess): JsonRecord[] {
  return fake.written.map((text) => asRecord(parseJson(text)) ?? {});
}

function written(fake: FakeLineProcess, method: string): JsonRecord | undefined {
  return lines(fake).find((message) => message.method === method);
}

function replies(fake: FakeLineProcess): JsonRecord[] {
  return lines(fake).filter((message) => message.method === undefined && "result" in message);
}

function codeOf(outcome: { readonly kind: string; readonly code?: string }): string {
  return outcome.kind === "rejected" ? outcome.code ?? "" : outcome.kind;
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

test("approvals decide the thread's policy: never for YOLO; untrusted, reviewed by the user, for ask", async () => {
  const yolo = scriptedAppServer();
  const plain = await codexSession(installation, { cwd: "/work" });
  const ask = scriptedAppServer();
  const asking = await codexSession(installation, { cwd: "/work", approvals: "ask" });
  expect([written(yolo, "thread/start")?.params, written(ask, "thread/start")?.params]).toMatchObject([
    { approvalPolicy: "never" },
    { approvalPolicy: "untrusted", approvalsReviewer: "user" },
  ]);
  expect(asRecord(written(yolo, "thread/start")?.params)?.approvalsReviewer).toBeUndefined();
  await Promise.all([plain.dispose(), asking.dispose()]);
});

test("an ask session codex opens under another policy is refused, never run ungated", async () => {
  const fake = scriptedAppServer({ approvalPolicy: "never" });
  await expect(codexSession(installation, { cwd: "/work", approvals: "ask" })).rejects.toThrow(
    'codex thread/start runs approvalPolicy "never" although "untrusted" was requested for approvals "ask"',
  );
  expect(fake.killed()).toBe(true);
});

function askOf(record: RawEvent | undefined): unknown {
  return record?.kind === "request" && record.body.kind === "native" ? record.body.ask : null;
}

async function askSession(): Promise<{ readonly fake: FakeLineProcess; readonly session: Awaited<ReturnType<typeof codexSession>> }> {
  const fake = scriptedAppServer();
  const session = await codexSession(installation, { cwd: "/work", approvals: "ask" });
  return { fake, session };
}

test("a command approval is a toApp request with what it asks, under codex's own id and turn", async () => {
  const { session } = await askSession();
  await session.prompt("command");
  const request = session.records().find((record) => record.kind === "request" && record.direction === "toApp");
  expect([request?.kind === "request" ? request.id : null, request?.spanId, askOf(request)]).toEqual([
    "7",
    "turn-1",
    { kind: "tool_approval", tool: "commandExecution", callId: "call_1", command: "/bin/zsh -lc 'touch x'", cwd: "/work", choices: ["allow", "allow_session", "deny"], denyMessage: false },
  ]);
  expect(session.status().value.awaiting).toEqual(["7"]);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- one approval from ask to turn end, asserted end to end.
test("the answer is the JSON-RPC response under codex's own id; codex's resolution report after it is no withdrawal", async () => {
  const { fake, session } = await askSession();
  const prompt = await session.prompt("command");
  const message = await session.answer("7", { kind: "deny", message: "no" });
  const answered = await session.answer("7", { kind: "allow", scope: "session" });
  expect([codeOf(message), answered.kind]).toEqual(["unsupported", "accepted"]);
  expect(replies(fake).at(-1)).toEqual({ id: 7, result: { decision: "acceptForSession" } });
  send(fake, { method: "serverRequest/resolved", params: { threadId, requestId: 7 } });
  send(fake, { method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
  expect(session.records().filter((record) => record.seq > prompt.seq).map((record) => describe(record))).toEqual([
    "response accepted",
    "frame turn/started",
    "frame item/started → tool_call_started",
    "toApp item/commandExecution/requestApproval",
    "toRuntime answer",
    "response rejected:unsupported",
    "toRuntime answer",
    "response answered",
    "response accepted",
    "frame serverRequest/resolved",
    "frame turn/completed → turn_ended",
  ]);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the interrupt, the turn end, the withdrawal and the late answer are one scenario.
test("a request codex clears on an interrupt is withdrawn: the answer after it is rejected, nothing sent", async () => {
  const { fake, session } = await askSession();
  const prompt = await session.prompt("command");
  const abort = await session.abort();
  expect(abort.kind).toBe("accepted");
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
  const late = await session.answer("7", { kind: "allow" });
  expect(codeOf(late)).toBe("withdrawn");
  expect(session.records().at(-3)).toMatchObject({ kind: "frame", body: { type: "serverRequest/resolved", events: [{ kind: "app_request_withdrawn", requestId: "7" }] } });
  expect(replies(fake).filter((sent) => sent.id === 7)).toEqual([]);
  expect(session.status().value.awaiting).toBeUndefined();
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- two asks of one session and both replies.
test("a file-change approval carries the item's paths and diff; a question maps its answers by question id", async () => {
  const { fake, session } = await askSession();
  await session.prompt("patch");
  const asks = (): unknown[] => session.records().flatMap((record) => (record.kind === "request" && record.body.kind === "native" ? [record.body.ask] : []));
  expect(asks()).toMatchObject([{ kind: "tool_approval", tool: "fileChange", callId: "call_2", reason: "write outside the workspace", paths: ["/work/a.txt"], diff: "+hello\n" }]);
  const denied = await session.answer("8", { kind: "deny" });
  send(fake, { method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  await session.prompt("question");
  expect(asks()[1]).toMatchObject({ kind: "question", choices: ["answer"], questions: [{ id: "color", question: "Which color?", other: true, options: [{ label: "Red", description: "warm" }] }] });
  const answered = await session.answer("9", { kind: "answer", answers: { color: "Red" } });
  expect([denied.kind, answered.kind]).toEqual(["accepted", "accepted"]);
  expect(replies(fake).slice(-2)).toEqual([
    { id: 8, result: { decision: "decline" } },
    { id: 9, result: { answers: { color: { answers: ["Red"] } } } },
  ]);
  await session.dispose();
});
