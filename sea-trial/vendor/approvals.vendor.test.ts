import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AppAsk, AppDecision, ControlOutcome, RuntimeEventBody, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, type Runtime } from "../../packages/oar/src/index.js";
import { claudeShell, codexShell, startClaudeAimock, startCodexAimock, type AimockEnv, type LLMock, type ShellCall } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { promptTurn } from "./support/asserts.js";

/**
 * Session.answer through the real harnesses, the provider scripted: what
 * each decision makes the runtime do. `allow` runs the tool, `allow` for the
 * session lets the same command through unasked on the next turn, `deny`
 * leaves the command unrun and (claude) hands the model its message, and
 * claude's AskUserQuestion takes the answers. The shared behavior cases
 * (cases/session-approvals.ts) hold the runtime-independent promises.
 */

interface Round {
  readonly asks: readonly AppAsk[];
  readonly events: readonly RuntimeEventBody[];
  readonly outcome: unknown;
}

/** One turn, answering every ask it raises with `decide`. */
async function round(session: Session, input: string, decide: (ask: AppAsk) => AppDecision): Promise<Round> {
  const asks: AppAsk[] = [];
  const answers: Promise<ControlOutcome>[] = [];
  const prompt = await promptTurn(session, input);
  const stop = session.events((event) => {
    if (event.kind === "app_request" && event.ask !== undefined) {
      asks.push(event.ask);
      answers.push(session.answer(event.requestId, decide(event.ask)));
    }
  }, { cursor: { sessionId: session.id, afterSeq: prompt.request.seq } });
  const outcome = await awaitTurnEnd(session, prompt.request.seq);
  stop();
  const outcomes = await Promise.all(answers);
  expect(outcomes.map((answered) => answered.kind)).toEqual(asks.map(() => "accepted"));
  const events = session.records().filter((record) => record.seq > prompt.request.seq).flatMap((record) => (record.kind === "frame" ? record.body.events : []));
  return { asks, events, outcome };
}

function toolEnds(events: readonly RuntimeEventBody[]): { readonly result: string | undefined; readonly output: string | undefined }[] {
  return events.flatMap((event) => (event.kind === "tool_call_ended" ? [{ result: event.result, output: event.output }] : []));
}

async function withShellScript(
  start: (configure: (mock: LLMock) => void) => Promise<AimockEnv>,
  shell: ShellCall,
  body: (subject: ReturnType<typeof runtimeUnderTest>, dir: string, runtime: Runtime) => Promise<void>,
  runtime: Runtime,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-approvals-vendor-"));
  const env = await start((mock) => {
    for (const name of ["allowed", "session", "denied"]) {
      mock.on({ userMessage: new RegExp(`oar-${name}-probe`, "u"), hasToolResult: false }, { toolCalls: [shell(`touch ${path.join(dir, name)}`)] });
    }
    mock.on({ userMessage: /oar-question-probe/u, hasToolResult: false }, {
      toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] }) }],
    });
    mock.on({ hasToolResult: true }, { content: "done" });
    mock.onMessage(/[\s\S]*/u, { content: "ok" });
  });
  try {
    await body(runtimeUnderTest(runtime, env.env), dir, runtime);
  } finally {
    await env.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude approvals through the real harness", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("allow runs the tool; a session grant lets it run again unasked; a deny's message is what the model reads", async () => {
    await withShellScript(startClaudeAimock, claudeShell, async (subject, dir) => {
      const session = await subject.startSession({ approvals: "ask" });
      const allowed = await round(session, "oar-allowed-probe", () => ({ kind: "allow" }));
      expect({ asked: allowed.asks.map((ask) => ask.kind), ran: existsSync(path.join(dir, "allowed")), ends: toolEnds(allowed.events), outcome: allowed.outcome }).toMatchInlineSnapshot(`
        {
          "asked": [
            "tool_approval",
          ],
          "ends": [
            {
              "output": ""(Bash completed with no output)"",
              "result": "ok",
            },
          ],
          "outcome": {
            "kind": "completed",
          },
          "ran": true,
        }
      `);
      const granted = await round(session, "oar-session-probe", () => ({ kind: "allow", scope: "session" }));
      const again = await round(session, "oar-session-probe", () => ({ kind: "deny", message: "should not be asked" }));
      expect([granted.asks.length, again.asks.length, toolEnds(again.events)]).toEqual([1, 0, [{ result: "ok", output: JSON.stringify("(Bash completed with no output)") }]]);
      const denied = await round(session, "oar-denied-probe", () => ({ kind: "deny", message: "not now, use the staging box" }));
      expect({ ran: existsSync(path.join(dir, "denied")), ends: toolEnds(denied.events), outcome: denied.outcome }).toEqual({
        ran: false,
        ends: [{ result: "failed", output: JSON.stringify("not now, use the staging box") }],
        outcome: { kind: "completed" },
      });
      await session.dispose();
    }, runtime);
  }, 180_000);

  test("AskUserQuestion is a question; the chosen answer is what the model reads back", async () => {
    await withShellScript(startClaudeAimock, claudeShell, async (subject) => {
      const session = await subject.startSession({ approvals: "ask" });
      const asked = await round(session, "oar-question-probe", (ask) => (ask.kind === "question" ? { kind: "answer", answers: { [ask.questions[0]?.id ?? ""]: "Blue" } } : { kind: "deny" }));
      expect(asked.asks.map((ask) => (ask.kind === "question" ? ask.questions.map((question) => [question.id, question.options.map((option) => option.label)]) : ask.kind))).toEqual([[["Which color?", ["Red", "Blue"]]]]);
      const [end] = toolEnds(asked.events);
      expect(end?.output).toContain(String.raw`\"Which color?\"=\"Blue\"`);
      await session.dispose();
    }, runtime);
  }, 180_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex approvals through the real harness", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });

  test("accept runs the command; acceptForSession lets it run again unasked; decline leaves it unrun and the turn goes on", async () => {
    await withShellScript(startCodexAimock, codexShell, async (subject, dir) => {
      const session = await subject.startSession({ approvals: "ask" });
      const allowed = await round(session, "oar-allowed-probe", () => ({ kind: "allow" }));
      expect({ asked: allowed.asks.map((ask) => (ask.kind === "tool_approval" ? [ask.tool, ask.command?.endsWith(`touch ${path.join(dir, "allowed")}'`)] : ask.kind)), ran: existsSync(path.join(dir, "allowed")), outcome: allowed.outcome }).toEqual({
        asked: [["commandExecution", true]],
        ran: true,
        outcome: { kind: "completed" },
      });
      const granted = await round(session, "oar-session-probe", () => ({ kind: "allow", scope: "session" }));
      const again = await round(session, "oar-session-probe", () => ({ kind: "deny" }));
      expect([granted.asks.length, again.asks.length]).toEqual([1, 0]);
      const denied = await round(session, "oar-denied-probe", () => ({ kind: "deny" }));
      expect({ ran: existsSync(path.join(dir, "denied")), outcome: denied.outcome }).toEqual({ ran: false, outcome: { kind: "completed" } });
      await session.dispose();
    }, runtime);
  }, 180_000);
});
