import { expect, test } from "vitest";
import type { AdapterSession, AppAsk, RawEvent, RequestRecord } from "../packages/oar/src/index.js";
import { createSessionKernel, sealSession, type SessionKernel } from "../packages/oar/src/kernel.js";
import { stallOf, statusOf } from "../packages/oar/src/observe/agent-status.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { PI_APPROVALS, piSession } from "../packages/oar/src/runtimes/pi/session.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

/*
 * Session.answer's contract, runtime-independent: the kernel's bookkeeping
 * (open / answered / withdrawn read off the stream, the recorded ask's
 * choices), the records an answer leaves, and the folds that read them.
 */

const ASK: AppAsk = { kind: "tool_approval", tool: "Bash", command: "rm -rf build", choices: ["allow", "allow_session", "deny"], denyMessage: false };
const WITHDRAWN = { type: "control_cancel_request", native: {}, events: [{ kind: "app_request_withdrawn", requestId: "ask-1" }] } as const;

function describe(record: RawEvent): string {
  switch (record.kind) {
    case "request":
      return `${record.direction} ${record.body.kind}${record.body.kind === "answer" ? ` ${record.body.requestId}` : ""}`;
    case "response":
      return `response ${record.body.kind}${record.body.kind === "rejected" ? `:${record.body.code}` : ""} → ${record.requestId}`;
    case "frame":
      return `frame ${record.body.events.map((event) => event.kind).join(",")}`;
    default:
      return "?";
  }
}

async function refuse(): Promise<never> {
  await Promise.resolve();
  throw new Error("not in this test");
}

type Deliver = Parameters<SessionKernel["answer"]>[2];

const sendDecision: Deliver = (_request, decision) => ({ kind: "sent", native: { sent: decision } });

/** A kernel with one open toApp request `ask-1`, and a sealed session whose answers `send` delivers. */
function asked(send: Deliver = sendDecision): { readonly kernel: SessionKernel; readonly session: ReturnType<typeof sealSession> } {
  const kernel = createSessionKernel("s1");
  const adapter: AdapterSession = {
    id: kernel.sessionId,
    capabilities: { steer: false, queue: null, attribution: "none", approvals: { kind: "supported" } },
    prompt: refuse,
    steer: refuse,
    queue: refuse,
    abort: refuse,
    answer: async (requestId, decision) => {
      await Promise.resolve();
      return kernel.answer(requestId, decision, send);
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      kernel.request("toRuntime", { kind: "dispose" });
      await Promise.resolve();
    },
  };
  kernel.request("toApp", { kind: "native", type: "can_use_tool", native: { tool: "Bash" }, ask: ASK }, { id: "ask-1", agentPath: ["task-7"] });
  return { kernel, session: sealSession(adapter) };
}

function codeOf(outcome: { readonly kind: string; readonly code?: string; readonly reason?: string }): string {
  return outcome.kind === "rejected" ? `${outcome.code ?? ""}: ${outcome.reason ?? ""}` : outcome.kind;
}

test("an answer is recorded like a control: the answer request, the toApp request's answered response at its envelope, then accepted", async () => {
  const { kernel, session } = asked();
  const outcome = await session.answer("ask-1", { kind: "allow", scope: "session" });
  expect(outcome.kind).toBe("accepted");
  expect(kernel.records().map((record) => describe(record))).toEqual([
    "toApp native",
    "toRuntime answer ask-1",
    "response answered → ask-1",
    `response accepted → ${outcome.requestId}`,
  ]);
  const answered = kernel.records().find((record) => record.kind === "response" && record.body.kind === "answered");
  expect(answered).toMatchObject({ agentPath: ["task-7"], body: { kind: "answered", native: { sent: { kind: "allow", scope: "session" } } } });
  expect(kernel.openRequests()).toEqual([]);
});

test("the first answer stands: two answers racing get one accept and one already_answered", async () => {
  const { session } = asked();
  const [first, second] = await Promise.all([session.answer("ask-1", { kind: "allow" }), session.answer("ask-1", { kind: "deny" })]);
  expect([first.kind, second.kind === "rejected" ? second.code : second.kind]).toEqual(["accepted", "already_answered"]);
});

test("rejections leave the request open and carry one typed code, read as control_rejected events", async () => {
  const { kernel, session } = asked();
  const outcomes = await Promise.all([
    session.answer("nope", { kind: "allow" }),
    session.answer("ask-1", { kind: "answer", answers: { q: "a" } }),
    session.answer("ask-1", { kind: "deny", message: "use pnpm" }),
  ]);
  expect(outcomes.map((outcome) => codeOf(outcome))).toMatchInlineSnapshot(`
    [
      "unknown_request: no runtime request nope in this session",
      "unsupported: this tool_approval takes allow, allow_session, deny, not answer",
      "unsupported: this runtime carries no deny message to the model; deny without one",
    ]
  `);
  expect(kernel.openRequests().map((request) => request.id)).toEqual(["ask-1"]);
  const actions = new Map(outcomes.map((outcome) => [outcome.requestId, "answer" as const]));
  const rejected = kernel.records().flatMap((record) => eventsOf(record, actions)).flatMap((event) => (event.kind === "control_rejected" ? [event.action] : []));
  expect(rejected).toEqual(["answer", "answer", "answer"]);
});

// oxlint-disable-next-line eslint/max-statements -- five ways an answer finds its request gone, side by side.
test("a withdrawn request, a delivery refusal, a thrown delivery, an exit and a dispose each reject the answer", async () => {
  const withdrawn = asked();
  withdrawn.kernel.frame(WITHDRAWN);
  const refused = asked(() => ({ kind: "rejected", code: "unsupported", reason: "not here" }));
  const thrown = asked(() => {
    throw new Error("stdin closed");
  });
  const exited = asked();
  exited.kernel.respond("", { kind: "exited", code: null });
  const disposed = asked();
  await disposed.session.dispose();
  const outcomes = await Promise.all([withdrawn, refused, thrown, exited, disposed].map(async ({ session }) => session.answer("ask-1", { kind: "allow" })));
  expect(outcomes.map((outcome) => codeOf(outcome))).toMatchInlineSnapshot(`
    [
      "withdrawn: the runtime withdrew request ask-1",
      "unsupported: not here",
      "error: stdin closed",
      "runtime_exited: runtime exited",
      "disposed: session disposed",
    ]
  `);
  expect([withdrawn, exited].map(({ kernel }) => kernel.openRequests().length)).toEqual([0, 0]);
});

test("a native decision goes through for a request oar read no ask from", async () => {
  const { kernel, session } = asked();
  kernel.request("toApp", { kind: "native", type: "mcpServer/elicitation/request", native: {} }, { id: "form-1" });
  const typed = await session.answer("form-1", { kind: "allow" });
  const native = await session.answer("form-1", { kind: "native", native: { action: "decline" } });
  expect([typed.kind === "rejected" ? typed.code : typed.kind, native.kind]).toEqual(["unsupported", "accepted"]);
});

test("the app_request event carries the ask; a withdrawal is a frame's event", () => {
  const { kernel } = asked();
  kernel.frame(WITHDRAWN);
  const events = kernel.records().flatMap((record) => eventsOf(record));
  expect(events.map((event) => (event.kind === "app_request" ? { kind: event.kind, ask: event.ask?.kind } : { kind: event.kind }))).toEqual([
    { kind: "app_request", ask: "tool_approval" },
    { kind: "app_request_withdrawn" },
  ]);
});

/** A running turn in its tool phase, with the approval `ask-1` open. */
function held(): SessionKernel {
  const kernel = createSessionKernel("s1");
  const prompt = kernel.request("toRuntime", { kind: "prompt", input: "go" });
  kernel.respond(prompt.id, { kind: "accepted" });
  kernel.frame({ type: "assistant", native: {}, events: [{ kind: "tool_call_started", callId: "c1", tool: "Bash" }] });
  kernel.request("toApp", { kind: "native", type: "can_use_tool", native: {}, ask: ASK }, { id: "ask-1" });
  // A request oar serves itself (an ACP terminal) owes the person nothing.
  kernel.request("toApp", { kind: "native", type: "terminal/output", native: {} }, { id: "term-1" });
  return kernel;
}

// oxlint-disable-next-line eslint/max-statements -- the wait, the answer, and the clock around both are one timeline.
test("status says who owes an answer, beside the phase; the silence is no stall while it does", () => {
  const kernel = held();
  const waiting = statusOf(kernel.records(), "s1").value;
  expect(waiting).toMatchObject({ kind: "running", phase: { tool: "Bash", callId: "c1" }, awaiting: ["ask-1"] });
  const asking = kernel.records().at(-2)?.receivedAt ?? 0;
  expect(stallOf(waiting, asking + 3_600_000, 1000)).toBeNull();
  kernel.respond("ask-1", { kind: "answered", native: {} });
  const answered = statusOf(kernel.records(), "s1").value;
  expect(answered.awaiting).toBeUndefined();
  const clock = answered.kind === "running" ? answered.lastEventAt : 0;
  expect(clock).toBeGreaterThanOrEqual(asking);
  expect(stallOf(answered, clock + 5000, 1000)).not.toBeNull();
});

test("a withdrawal or the exit ends the wait: nothing is awaited forever", () => {
  const withdrawn = held();
  withdrawn.frame(WITHDRAWN);
  const exited = held();
  exited.respond("", { kind: "exited", code: null });
  expect([withdrawn, exited].map((kernel) => statusOf(kernel.records(), "s1").value.awaiting)).toEqual([undefined, undefined]);
  expect(viewOf(exited.records()).pendingRequests).toEqual([]);
});

test("pi has no permission gate: an ask session is refused before anything opens, naming why", async () => {
  await expect(piSession({ kind: "available", via: "bundled" }, { cwd: process.cwd(), approvals: "ask" })).rejects.toThrow(
    `approvals "ask" is unsupported: ${PI_APPROVALS.reason}`,
  );
  expect(PI_APPROVALS).toMatchObject({ kind: "unsupported", code: "no_gate" });
});

test("the mock runtime's ask mode: the turn waits for the answer, then goes on", async () => {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd(), approvals: "ask" });
  const prompt = await session.prompt("oar-approval-probe");
  const pending = session.records().find((record): record is RequestRecord => record.kind === "request" && record.direction === "toApp");
  expect([prompt.kind, session.status().value.awaiting]).toEqual(["accepted", [pending?.id]]);
  const answer = await session.answer(pending?.id ?? "", { kind: "deny", message: "not today" });
  expect(answer.kind).toBe("accepted");
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
  const said = session.records().flatMap((record) => (record.kind === "frame" ? record.body.events : [])).find((event) => event.kind === "text_delta");
  expect(said).toEqual({ kind: "text_delta", text: "denied:not today" });
  await session.dispose();
});
