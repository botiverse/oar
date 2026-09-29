import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AppAsk, AppDecision, ControlOutcome, RawEvent, RuntimeEventBody, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, type Runtime } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { claudeShell, codexShell, startClaudeAimock, startCodexAimock, type AimockEnv, type LLMock, type ShellCall } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

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

/** One turn, answering every ask it raises with `decide`. */
async function round(session: Session, input: string, decide: (ask: AppAsk) => AppDecision): Promise<Round> {
  const asks: AppAsk[] = [];
  const answers: Promise<ControlOutcome>[] = [];
  const prompt = await session.prompt(input);
  expect(prompt.kind).toBe("accepted");
  const stop = session.events((event) => {
    if (event.kind === "app_request" && event.ask !== undefined) {
      asks.push(event.ask);
      answers.push(session.answer(event.requestId, decide(event.ask)));
    }
  }, { cursor: { sessionId: session.id, afterSeq: prompt.seq } });
  const outcome = await awaitTurnEnd(session, prompt.seq);
  stop();
  const outcomes = await Promise.all(answers);
  expect(outcomes.map((answered) => answered.kind)).toEqual(asks.map(() => "accepted"));
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

/** One command item that codex did not decline (completed, or failed where the shell has no `touch`). */
function ranOnce(statuses: readonly unknown[]): boolean {
  return statuses.length === 1 && statuses[0] !== "declined";
}

async function withScript(
  start: (configure: (mock: LLMock) => void) => Promise<AimockEnv>,
  shell: ShellCall,
  body: (open: () => Promise<Session>, dir: string) => Promise<void>,
  runtime: Runtime,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-approvals-vendor-"));
  const env = await start((mock) => {
    for (const name of ["allowed", "session", "denied"]) {
      mock.on({ userMessage: new RegExp(`oar-${name}-probe`, "u"), hasToolResult: false }, { toolCalls: [shell(`touch ${name}`)] });
    }
    mock.on({ userMessage: /oar-question-probe/u, hasToolResult: false }, {
      toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] }) }],
    });
    mock.on({ hasToolResult: true }, { content: "done" });
    mock.onMessage(/[\s\S]*/u, { content: "ok" });
  });
  try {
    await body(async () => runtimeUnderTest(runtime, env.env).startSession({ approvals: "ask", cwd: dir }), dir);
  } finally {
    await env.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude approvals through the real harness", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("allow runs the tool; a session grant lets it run again unasked; a deny's message is what the model reads", async () => {
    await withScript(startClaudeAimock, claudeShell, async (open, dir) => {
      const session = await open();
      const allowed = await round(session, "oar-allowed-probe", () => ({ kind: "allow" }));
      const granted = await round(session, "oar-session-probe", () => ({ kind: "allow", scope: "session" }));
      const again = await round(session, "oar-session-probe", () => ({ kind: "deny", message: "should not be asked" }));
      const denied = await round(session, "oar-denied-probe", () => ({ kind: "deny", message: "not now, use the staging box" }));
      expect({
        asked: [allowed, granted, again, denied].map((turn) => turn.asks.map((ask) => (ask.kind === "tool_approval" ? `${ask.tool}: ${ask.command ?? ""}` : ask.kind))),
        results: [allowed, again, denied].map((turn) => toolEnds(turn.records).map((end) => end.result)),
        deniedOutput: toolEnds(denied.records).map((end) => end.output),
        deniedRan: existsSync(path.join(dir, "denied")),
        outcomes: [allowed, granted, again, denied].map((turn) => turn.outcome),
      }).toEqual({
        asked: [["Bash: touch allowed"], ["Bash: touch session"], [], ["Bash: touch denied"]],
        results: [["ok"], ["ok"], ["failed"]],
        deniedOutput: [JSON.stringify("not now, use the staging box")],
        deniedRan: false,
        outcomes: [{ kind: "completed" }, { kind: "completed" }, { kind: "completed" }, { kind: "completed" }],
      });
      await session.dispose();
    }, runtime);
  }, 180_000);

  test("AskUserQuestion is a question; the chosen answer is what the model reads back", async () => {
    await withScript(startClaudeAimock, claudeShell, async (open) => {
      const session = await open();
      const asked = await round(session, "oar-question-probe", (ask) => (ask.kind === "question" ? { kind: "answer", answers: { [ask.questions[0]?.id ?? ""]: "Blue" } } : { kind: "deny" }));
      expect(asked.asks.map((ask) => (ask.kind === "question" ? ask.questions.map((question) => [question.id, question.options.map((option) => option.label)]) : ask.kind))).toEqual([[["Which color?", ["Red", "Blue"]]]]);
      const [end] = toolEnds(asked.records);
      expect(end?.output).toContain(String.raw`\"Which color?\"=\"Blue\"`);
      await session.dispose();
    }, runtime);
  }, 180_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex approvals through the real harness", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });

  test("accept runs the command; acceptForSession lets it run again unasked; decline leaves it unrun and the turn goes on", async () => {
    await withScript(startCodexAimock, codexShell, async (open, dir) => {
      const session = await open();
      const allowed = await round(session, "oar-allowed-probe", () => ({ kind: "allow" }));
      const granted = await round(session, "oar-session-probe", () => ({ kind: "allow", scope: "session" }));
      const again = await round(session, "oar-session-probe", () => ({ kind: "deny" }));
      const denied = await round(session, "oar-denied-probe", () => ({ kind: "deny" }));
      expect({
        asked: [allowed, granted, again, denied].map((turn) => turn.asks.map((ask) => (ask.kind === "tool_approval" ? ask.tool : ask.kind))),
        ran: [allowed, granted, again].map((turn) => ranOnce(commandStatuses(turn.records))),
        denied: commandStatuses(denied.records),
        deniedRan: existsSync(path.join(dir, "denied")),
        outcomes: [allowed, again, denied].map((turn) => turn.outcome),
      }).toEqual({
        asked: [["commandExecution"], ["commandExecution"], [], ["commandExecution"]],
        ran: [true, true, true],
        denied: ["declined"],
        deniedRan: false,
        outcomes: [{ kind: "completed" }, { kind: "completed" }, { kind: "completed" }],
      });
      await session.dispose();
    }, runtime);
  }, 180_000);
});
