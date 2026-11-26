import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { appRequestKind, awaitTurnEnd, claudeRuntime, codexRuntime, userQuestionOf, type Event, type Session, type UserQuestionAnswer } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

interface Run { readonly session: Session; readonly results: string[]; readonly events: Event[]; readonly stop: () => Promise<void> }

const CALLS = {
  claude: { name: "AskUserQuestion", arguments: { questions: [
    { question: "Which color?", header: "Color", options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }], multiSelect: false },
    { question: "Which sizes?", header: "Size", options: [{ label: "S", description: "s" }, { label: "M", description: "m" }], multiSelect: true },
  ] } },
  codex: { name: "request_user_input", arguments: { questions: [{ id: "color", header: "Color", question: "Which color?", options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }] }] } },
} as const;

async function open(vendor: "claude" | "codex"): Promise<Run> {
  const results: string[] = [];
  const call = CALLS[vendor];
  const provider = await (vendor === "claude" ? startClaudeAimock : startCodexAimock)((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      const last = request.messages.findLast((message) => message.role === "tool");
      if (last !== undefined) { results.push(JSON.stringify(last.content)); return { content: "finished" }; }
      return JSON.stringify(request.messages).includes("ASK_NOW") ? { toolCalls: [{ id: "call_question", name: call.name, arguments: JSON.stringify(call.arguments) }] } : { content: "metadata" };
    });
  });
  const temporary = await mkdtemp(path.join(tmpdir(), "oar-questions-"));
  const cwd = await realpath(temporary);
  const runtime = vendor === "claude" ? claudeRuntime : codexRuntime;
  const installation = await runtime.installation();
  expectAvailable(installation, vendor);
  const session = await runtime.session(installation, { cwd, userQuestions: "host", ...(vendor === "claude" ? { model: "sonnet" } : {}),
    env: { ...provider.env, ...(vendor === "claude" ? { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: path.join(cwd, ".claude"), ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}) } });
  const events: Event[] = [];
  session.events((event) => { events.push(event); });
  return { session, results, events, stop: async () => { await session.dispose(); await provider.stop(); await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } };
}

async function asked(run: Run): Promise<{ readonly id: string; readonly seq: number }> {
  const prompt = await run.session.prompt("ASK_NOW");
  expect(prompt.kind).toBe("accepted");
  await expect.poll(() => run.events.some((event) => event.kind === "app_request"), { timeout: 25_000 }).toBe(true);
  const request = run.session.records().find((record) => record.kind === "request" && record.direction === "toApp");
  if (request?.kind !== "request" || request.body.kind !== "native") { throw new Error("no native request"); }
  expect(appRequestKind(request.body.type, request.body.native)).toBe("question");
  expect(userQuestionOf(request.body.type, request.body.native)?.questions[0]).toMatchObject({ question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }], allowOther: true });
  expect(run.session.status().value.kind).toBe("running");
  return { id: request.id, seq: prompt.seq };
}

describe.each(["claude", "codex"] as const)("%s host questions", (vendor) => {
  const color = vendor === "claude" ? "Which color?" : "color";
  const cases: readonly (readonly [string, UserQuestionAnswer, RegExp])[] = [
    ["a choice", { kind: "answered", answers: { [color]: { selected: ["Blue"] } } }, /Blue/u],
    ["free text", { kind: "answered", answers: { [color]: { text: "teal please" } } }, /teal please/u],
    ...(vendor === "claude" ? [["several choices", { kind: "answered", answers: { [color]: { selected: ["Red"] }, "Which sizes?": { selected: ["S", "M"] } } }, /S, M/u] as const] : []),
    ["a decline", { kind: "declined" }, vendor === "claude" ? /declined to answer/u : /answers\W+\{\}/u],
  ];
  test.skipIf(process.env.OAR_TEST !== `${vendor}-aimock`).each(cases)("%s reaches the model and the turn goes on", async (_name, answer, expected) => {
    const run = await open(vendor);
    try {
      const { id, seq } = await asked(run);
      expect(await run.session.answerQuestion?.(id, answer)).toMatchObject({ kind: "answered", requestId: id });
      expect(await awaitTurnEnd(run.session, seq)).toMatchObject({ kind: "completed" });
      expect(run.results.join("\n")).toMatch(expected);
      expect(run.events.filter((event) => event.kind.startsWith("app_")).map((event) => event.kind)).toEqual(["app_request", "app_answered"]);
    } finally { await run.stop(); }
  }, 60_000);

  test.skipIf(process.env.OAR_TEST !== `${vendor}-aimock`)("an abort withdraws the open question", async () => {
    const run = await open(vendor);
    try {
      const { id, seq } = await asked(run);
      expect(await run.session.abort()).toMatchObject({ kind: "accepted" });
      expect(await awaitTurnEnd(run.session, seq)).toMatchObject({ kind: "aborted" });
      await expect.poll(() => run.events.filter((event) => event.kind.startsWith("app_")).map((event) => event.kind), { timeout: 10_000 }).toEqual(["app_request", "app_request_cancelled"]);
      expect(await run.session.answerQuestion?.(id, { kind: "declined" })).toMatchObject({ kind: "rejected", code: "already_resolved" });
    } finally { await run.stop(); }
  }, 60_000);
});

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex secret question answers reach the model and stay redacted across session.records()", async () => {
  const results: string[] = [];
  const pin = "73915";
  const secretToken = "CODEX_SECRET_ANSWER_CANARY_987654";
  const provider = await startCodexAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      const last = request.messages.findLast((message) => message.role === "tool");
      if (last !== undefined) { results.push(JSON.stringify(last.content)); return { content: `model noted ${secretToken}` }; }
      return { toolCalls: [{ id: "call_secret_question", name: "request_user_input", arguments: JSON.stringify({ questions: [
        { id: "pub", header: "Public", question: "Public color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }] },
        { id: "pin", header: "PIN", question: "Short PIN?", isOther: true, isSecret: true, options: [{ label: "Skip", description: "s" }] },
        { id: "tok", header: "Token", question: "Secret token?", isOther: true, isSecret: true, options: [{ label: "None", description: "n" }] },
      ] }) }] };
    });
  });
  const temporary = await mkdtemp(path.join(tmpdir(), "oar-secret-questions-"));
  const cwd = await realpath(temporary);
  const installation = await codexRuntime.installation();
  expectAvailable(installation, "codex");
  const session = await codexRuntime.session(installation, { cwd, userQuestions: "host", env: { ...provider.env } });
  try {
    const prompt = await session.prompt("ASK_SECRET");
    await expect.poll(() => session.records().some((record) => record.kind === "request" && record.direction === "toApp"), { timeout: 25_000 }).toBe(true);
    const request = session.records().find((record) => record.kind === "request" && record.direction === "toApp");
    if (request?.kind !== "request") { throw new Error("no native request"); }
    expect(await session.answerQuestion?.(request.id, { kind: "answered", answers: { pub: { selected: ["Blue"] }, pin: { text: pin }, tok: { text: secretToken } } })).toMatchObject({ kind: "answered" });
    expect(await awaitTurnEnd(session, prompt.seq)).toMatchObject({ kind: "completed" });
    expect(results.join("\n")).toContain(pin);
    expect(results.join("\n")).toContain(secretToken);
    const recorded = JSON.stringify(session.records());
    expect(recorded).toContain("Blue");
    expect(recorded).not.toContain(pin);
    expect(recorded).not.toContain(secretToken);
  } finally { await session.dispose(); await provider.stop(); await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 60_000);
