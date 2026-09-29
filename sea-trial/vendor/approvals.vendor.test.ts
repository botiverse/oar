import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AppAsk, AppDecision, ControlOutcome, RawEvent, RuntimeEventBody, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, type Runtime } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { claudeShell, codexShell, startClaudeAimock, startCodexAimock, type AimockEnv, type LLMock, type ShellCall } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { openTrace } from "../harness/trace.js";

// A red run ships its trajectory, as the other vendor tests do (support/tool-round.ts).
openTrace(`vendor-${process.env.OAR_TEST ?? "unset"}`);

/**
 * Session.answer through the real harnesses, the provider scripted: what
 * each decision makes the runtime do, read from the runtime's own reports
 * (tool results, item status), in a scratch cwd with relative paths so it
 * holds on every OS. `allow` runs the tool, `allow` for the session lets
 * the same command through unasked on the next turn, `deny` leaves it unrun
 * (claude hands the model its message), and claude's AskUserQuestion takes
 * the answers. The shared behavior cases (cases/session-approvals.ts) hold
 * the runtime-independent promises.
 */

interface Round {
  readonly asks: readonly AppAsk[];
  readonly records: readonly RawEvent[];
  readonly outcome: unknown;
}

/** A refused answer leaves the turn held; abort it so the test reports the refusal instead of timing out. */
async function answerOrAbort(session: Session, requestId: string, decision: AppDecision): Promise<ControlOutcome> {
  const outcome = await session.answer(requestId, decision);
  if (outcome.kind === "rejected") {
    await session.abort();
  }
  return outcome;
}

/** One turn, answering every ask it raises with `decide`. */
async function round(session: Session, input: string, decide: (ask: AppAsk) => AppDecision): Promise<Round> {
  const asks: AppAsk[] = [];
  const answers: Promise<ControlOutcome>[] = [];
  const prompt = await session.prompt(input);
  expect(prompt.kind).toBe("accepted");
  const stop = session.events((event) => {
    if (event.kind === "app_request" && event.ask !== undefined) {
      asks.push(event.ask);
      answers.push(answerOrAbort(session, event.requestId, decide(event.ask)));
    }
  }, { cursor: { sessionId: session.id, afterSeq: prompt.seq } });
  const outcome = await awaitTurnEnd(session, prompt.seq);
  stop();
  const outcomes = await Promise.all(answers);
  expect(outcomes.map((answered) => (answered.kind === "rejected" ? answered.code : answered.kind))).toEqual(asks.map(() => "accepted"));
  return { asks, records: session.records().filter((record) => record.seq > prompt.seq), outcome };
}

function toolEnds(records: readonly RawEvent[]): { readonly result: string | undefined; readonly output: string | undefined }[] {
  const events: RuntimeEventBody[] = records.flatMap((record) => (record.kind === "frame" ? record.body.events : []));
  return events.flatMap((event) => (event.kind === "tool_call_ended" ? [{ result: event.result, output: event.output }] : []));
}

/** codex's own status for each commandExecution item that completed: ran (completed / failed) or declined. */
function commandStatuses(records: readonly RawEvent[]): unknown[] {
  return records.flatMap((record) => {
    const item = record.kind === "frame" && record.body.type === "item/completed" ? asRecord(asRecord(record.body.native)?.item) : null;
    return item?.type === "commandExecution" ? [item.status] : [];
  });
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/** One command item that codex did not decline (completed, or failed where the shell has no `touch`). */
function ranOnce(statuses: readonly unknown[]): boolean {
  return statuses.length === 1 && statuses[0] !== "declined";
}

/** The probe commands, relative so every shell reads them alike; the session one writes outside the cwd, where claude's grant needs its directory too. */
const PROBES = { allowed: "touch allowed", session: "touch ../session", denied: "touch denied" } as const;

function approvalFixtures(mock: LLMock, shell: ShellCall): void {
  for (const [name, command] of Object.entries(PROBES)) {
    mock.on({ userMessage: new RegExp(`oar-${name}-probe`, "u"), hasToolResult: false }, { toolCalls: [shell(command)] });
  }
  mock.on({ userMessage: /oar-question-probe/u, hasToolResult: false }, {
    toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] }) }],
  });
  mock.on({ hasToolResult: true }, { content: "done" });
  mock.onMessage(/[\s\S]*/u, { content: "ok" });
}

/**
 * The sessions a test opens in `dir`, all disposed on close, and by a
 * watchdog before the test's own timeout: a held turn ends, so a hang
 * surfaces as the expectation it breaks rather than as a timeout.
 */
function sessionPool(runtime: Runtime, env: AimockEnv, dir: string): { readonly open: () => Promise<Session>; readonly close: () => Promise<void> } {
  const sessions: Session[] = [];
  const disposeAll = async (): Promise<void> => {
    await Promise.all(sessions.map(async (session) => session.dispose()));
  };
  const watchdog = setTimeout(() => { void disposeAll(); }, 120_000);
  return {
    open: async () => {
      const session = await runtimeUnderTest(runtime, env.env).startSession({ approvals: "ask", cwd: dir });
      sessions.push(session);
      return session;
    },
    close: async () => {
      clearTimeout(watchdog);
      await disposeAll();
    },
  };
}

/**
 * A scratch root and the session cwd inside it, by the long name: a Windows
 * temp dir is an 8.3 short path (RUNNER~1), which claude's safety check flags
 * as suspicious, offering no session grant there (`suppress_always_allow_rule`).
 */
async function scratch(): Promise<{ readonly dir: string; readonly cwd: string }> {
  const created = await mkdtemp(path.join(tmpdir(), "oar-approvals-vendor-"));
  const dir = await realpath(created);
  const cwd = path.join(dir, "work");
  await mkdir(cwd);
  return { dir, cwd };
}

async function withScript(
  start: (configure: (mock: LLMock) => void) => Promise<AimockEnv>,
  shell: ShellCall,
  body: (open: () => Promise<Session>, cwd: string) => Promise<void>,
  runtime: Runtime,
): Promise<void> {
  const { dir, cwd } = await scratch();
  const env = await start((mock) => { approvalFixtures(mock, shell); });
  const pool = sessionPool(runtime, env, cwd);
  try {
    await body(pool.open, cwd);
  } finally {
    // Before the mock stops: a live runtime's connection would hold the stop.
    await pool.close();
    await env.stop();
    // Windows holds a directory a moment after the process that ran in it exits.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude approvals through the real harness", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("allow runs the tool; a session grant lets it run again unasked; a deny's message is what the model reads", async () => {
    await withScript(startClaudeAimock, claudeShell, async (open, cwd) => {
      const session = await open();
      const allowed = await round(session, "oar-allowed-probe", () => ({ kind: "allow" }));
      const granted = await round(session, "oar-session-probe", () => ({ kind: "allow", scope: "session" }));
      const again = await round(session, "oar-session-probe", () => ({ kind: "deny", message: "should not be asked" }));
      const denied = await round(session, "oar-denied-probe", () => ({ kind: "deny", message: "not now, use the staging box" }));
      expect({
        asked: [allowed, granted, again, denied].map((turn) => turn.asks.map((ask) => (ask.kind === "tool_approval" ? `${ask.tool}: ${ask.command ?? ""}` : ask.kind))),
        results: [allowed, again, denied].map((turn) => toolEnds(turn.records).map((end) => end.result)),
        deniedOutput: toolEnds(denied.records).map((end) => end.output),
        deniedRan: await exists(path.join(cwd, "denied")),
        outcomes: [allowed, granted, again, denied].map((turn) => turn.outcome),
      }).toEqual({
        asked: [[`Bash: ${PROBES.allowed}`], [`Bash: ${PROBES.session}`], [], [`Bash: ${PROBES.denied}`]],
        results: [["ok"], ["ok"], ["failed"]],
        deniedOutput: [JSON.stringify("not now, use the staging box")],
        deniedRan: false,
        outcomes: [{ kind: "completed" }, { kind: "completed" }, { kind: "completed" }, { kind: "completed" }],
      });
    }, runtime);
  }, 180_000);

  test("AskUserQuestion is a question; the chosen answer is what the model reads back", async () => {
    await withScript(startClaudeAimock, claudeShell, async (open) => {
      const session = await open();
      const asked = await round(session, "oar-question-probe", (ask) => (ask.kind === "question" ? { kind: "answer", answers: { [ask.questions[0]?.id ?? ""]: "Blue" } } : { kind: "deny" }));
      expect(asked.asks.map((ask) => (ask.kind === "question" ? ask.questions.map((question) => [question.id, question.options.map((option) => option.label)]) : ask.kind))).toEqual([[["Which color?", ["Red", "Blue"]]]]);
      const [end] = toolEnds(asked.records);
      expect(end?.output).toContain(String.raw`\"Which color?\"=\"Blue\"`);
    }, runtime);
  }, 180_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex approvals through the real harness", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });

  test("accept runs the command; acceptForSession lets it run again unasked; decline leaves it unrun and the turn goes on", async () => {
    await withScript(startCodexAimock, codexShell, async (open, cwd) => {
      const session = await open();
      const allowed = await round(session, "oar-allowed-probe", () => ({ kind: "allow" }));
      const granted = await round(session, "oar-session-probe", () => ({ kind: "allow", scope: "session" }));
      const again = await round(session, "oar-session-probe", () => ({ kind: "deny" }));
      const denied = await round(session, "oar-denied-probe", () => ({ kind: "deny" }));
      expect({
        asked: [allowed, granted, again, denied].map((turn) => turn.asks.map((ask) => (ask.kind === "tool_approval" ? ask.tool : ask.kind))),
        ran: [allowed, granted, again].map((turn) => ranOnce(commandStatuses(turn.records))),
        denied: commandStatuses(denied.records),
        deniedRan: await exists(path.join(cwd, "denied")),
        outcomes: [allowed, again, denied].map((turn) => turn.outcome),
      }).toEqual({
        asked: [["commandExecution"], ["commandExecution"], [], ["commandExecution"]],
        ran: [true, true, true],
        denied: ["declined"],
        deniedRan: false,
        outcomes: [{ kind: "completed" }, { kind: "completed" }, { kind: "completed" }],
      });
    }, runtime);
  }, 180_000);
});
