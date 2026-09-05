import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Session, SessionEvent, Turn } from "../../packages/oar/src/contracts/session.js";
import {
  acpSession,
  type AcpSessionProfile,
} from "../../packages/oar/src/shared/acp/session.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));
const installation = {
  kind: "available",
  via: "executable",
  command: process.execPath,
} as const;

function profile(overrides: Partial<AcpSessionProfile> = {}): AcpSessionProfile {
  return {
    args: [fixture, "session"],
    selectAuthMethod: () => "cached",
    abortTimeoutMs: 500,
    configureSession: async ({ connection, sessionId, requestOptions }) => {
      await connection.agent.request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
        requestOptions,
      );
    },
    ...overrides,
  };
}

async function start(
  overrides: Partial<AcpSessionProfile> = {},
  resume?: string,
  model?: string,
): Promise<Session> {
  return acpSession(profile(overrides))(installation, {
    cwd: process.cwd(),
    ...(resume === undefined ? {} : { resume }),
    ...(model === undefined ? {} : { model }),
  });
}

function turn(result: ReturnType<Session["prompt"]>): Turn {
  assert.equal(result.kind, "turn");
  return result.turn;
}

function bodies(events: readonly SessionEvent[]): unknown[] {
  return events.map(({ sessionId: _sessionId, turnId: _turnId, seq: _seq, receivedAt: _receivedAt, ...body }) => body);
}

test("ACP session maps message, thought, tool, and usage updates", async () => {
  const session = await start();
  const events: SessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  const active = turn(session.prompt("tool"));

  assert.deepEqual(await active.outcome, { kind: "completed" });
  assert.deepEqual(bodies(events), [
    { kind: "turn_started" },
    { kind: "reasoning", content: { kind: "text", text: "inspect" } },
    {
      kind: "tool_call_started",
      callId: "call-read",
      tool: "Read",
      input: JSON.stringify({ path: "input.txt" }),
    },
    {
      kind: "tool_call_ended",
      callId: "call-read",
      output: JSON.stringify({ content: "fixture-value" }),
    },
    { kind: "text_delta", text: "tool-done" },
    { kind: "turn_ended", outcome: { kind: "completed" } },
  ]);
  assert.deepEqual(session.contextUsage?.(), {
    tokens: 500,
    contextWindow: 2000,
    percent: 25,
  });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- One lifecycle test must observe busy, abort, queue drain, and turn identity together.
test("ACP session enforces busy and drains its host-held queue as a new turn", async () => {
  const session = await start();
  const events: SessionEvent[] = [];
  const { promise: twoTurns, resolve } = Promise.withResolvers<void>();
  session.subscribe((event) => {
    events.push(event);
    if (events.filter((item) => item.kind === "turn_ended").length === 2) {
      resolve();
    }
  });
  const first = turn(session.prompt("hold"));
  assert.equal(session.prompt("must-be-busy").kind, "busy");
  const { queue } = session;
  assert.ok(queue);
  assert.equal(queue.durable, false);
  await queue.add("queued");
  await first.abort();

  assert.deepEqual(await first.outcome, { kind: "aborted" });
  await twoTurns;
  const ended = events.filter((event) => event.kind === "turn_ended");
  assert.equal(ended.length, 2);
  assert.notEqual(ended[0]?.turnId, ended[1]?.turnId);
  assert.ok(events.some((event) => event.kind === "text_delta" && event.text === "echo:queued"));
  await session.dispose();
});

test("ACP native steer adopts the newest prompt response into one OAR turn", async () => {
  const session = await start({ steerParams: () => ({ _meta: { sendNow: true } }) });
  const events: SessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  const active = turn(session.prompt("steer-base"));

  assert.deepEqual(await active.steer?.("steer-new"), { kind: "accepted" });
  assert.deepEqual(await active.outcome, { kind: "completed" });
  assert.deepEqual(events.filter((event) => event.kind === "turn_started").length, 1);
  assert.deepEqual(events.filter((event) => event.kind === "turn_ended").length, 1);
  assert.ok(events.some((event) => event.kind === "text_delta" && event.text === "steer:steer-new"));
  await session.dispose();
});

test("ACP reverse permission requests follow OAR's YOLO policy", async () => {
  const session = await start();
  const texts: string[] = [];
  session.subscribe((event) => {
    if (event.kind === "text_delta") {
      texts.push(event.text);
    }
  });
  const active = turn(session.prompt("permission"));
  assert.deepEqual(await active.outcome, { kind: "completed" });
  assert.deepEqual(texts, ["permission:always"]);
  await session.dispose();
});

test("ACP prompt errors and process exits settle as typed failures", async () => {
  const authSession = await start();
  const auth = turn(authSession.prompt("fail"));
  expect(await auth.outcome).toMatchInlineSnapshot(`
    {
      "failure": "auth",
      "kind": "failed",
      "reason": "Authentication required",
    }
  `);
  await authSession.dispose();

  const exitSession = await start();
  const exited = turn(exitSession.prompt("exit"));
  expect(await exited.outcome).toMatchInlineSnapshot(`
    {
      "failure": "runtime_exited",
      "kind": "failed",
      "reason": "ACP process exited with code 9",
    }
  `);
  await exitSession.dispose();
});

test("ACP resume keeps the runtime-native session id and remains usable", async () => {
  const first = await start();
  const sessionId = first.id;
  await first.dispose();

  const resumed = await start({}, sessionId);
  assert.equal(resumed.id, sessionId);
  const active = turn(resumed.prompt("after-resume"));
  assert.deepEqual(await active.outcome, { kind: "completed" });
  await resumed.dispose();
  await resumed.dispose();
});

function reportedModel(session: Session): string | null {
  return session.model?.() ?? null;
}

// The read-back must be the runtime's word, never the request parameter. The
// fixture accepts any `session/set_model` with an empty answer but keeps
// running fixture-model-x, the way grok falls back to its default for a model
// the account cannot use.
test("ACP model read-back reports the agent's effective model, not the requested one", async () => {
  const requested = await start({}, undefined, "requested-y");
  assert.equal(reportedModel(requested), "fixture-model-x");
  await requested.dispose();

  const resumed = await start({}, "fake-session", "requested-y");
  assert.equal(reportedModel(resumed), "fixture-model-x");
  await resumed.dispose();
});

test("ACP model read-back takes grok's set_model `_meta.model` over the session/new report", async () => {
  const session = await start({}, undefined, "grok-meta");
  assert.equal(reportedModel(session), "grok-applied");
  await session.dispose();
});

test("ACP model read-back sees kimi's config_option_update pushed before set_model answers", async () => {
  const session = await start({}, undefined, "kimi-push");
  assert.equal(reportedModel(session), "kimi-pushed");
  await session.dispose();
});

test("ACP model read-back follows config_option_update during a turn", async () => {
  const session = await start();
  assert.equal(reportedModel(session), "fixture-model-x");
  const active = turn(session.prompt("switch-model"));
  assert.deepEqual(await active.outcome, { kind: "completed" });
  assert.equal(reportedModel(session), "fixture-model-z");
  await session.dispose();
});

// kimi-code f9ca33376 answers `session/prompt` first and pushes the turn's
// `usage_update` afterwards (acp-server session.ts onTurnEnded →
// void emitUsageUpdate()). The "usage-after-response" fixture mode replays
// that order with `used` = 100 × turn number, so a stale read is visible.
const usageAfterResponse = [fixture, "usage-after-response"];

/** `contextUsage().tokens` as read inside each `turn_ended` handler, in order. */
function tokensAtTurnEnded(session: Session): readonly (number | null | undefined)[] {
  const seen: (number | null | undefined)[] = [];
  session.subscribe((event) => {
    if (event.kind === "turn_ended") {
      seen.push(session.contextUsage?.()?.tokens);
    }
  });
  return seen;
}

test("ACP usageUpdateAfterPrompt (kimi) holds the turn until the post-response usage_update lands", async () => {
  const session = await start({ args: usageAfterResponse, usageUpdateAfterPrompt: true });
  const atEnd = tokensAtTurnEnded(session);
  assert.deepEqual(await turn(session.prompt("one")).outcome, { kind: "completed" });
  assert.deepEqual(await turn(session.prompt("two")).outcome, { kind: "completed" });
  assert.deepEqual(atEnd, [100, 200]);
  assert.deepEqual(session.contextUsage?.(), { tokens: 200, contextWindow: 1000, percent: 20 });
  await session.dispose();
});

test("ACP usageUpdateAfterPrompt settles as-is once the bound passes without a usage_update", async () => {
  const session = await start({
    args: [fixture, "usage-never"],
    usageUpdateAfterPrompt: true,
    usageUpdateTimeoutMs: 100,
  });
  const started = performance.now();
  assert.deepEqual(await turn(session.prompt("one")).outcome, { kind: "completed" });
  assert.ok(performance.now() - started >= 90, "the turn should have waited for the bound");
  assert.equal(session.contextUsage?.(), null);
  await session.dispose();
});

test("ACP profiles without usageUpdateAfterPrompt (grok) settle on the response and read the previous turn's usage", async () => {
  const session = await start({ args: usageAfterResponse });
  const atEnd = tokensAtTurnEnded(session);
  assert.deepEqual(await turn(session.prompt("one")).outcome, { kind: "completed" });
  const atOutcome = session.contextUsage?.();
  assert.equal(atOutcome, null);
  await sleep(150);
  assert.deepEqual(session.contextUsage?.(), { tokens: 100, contextWindow: 1000, percent: 10 });
  assert.deepEqual(await turn(session.prompt("two")).outcome, { kind: "completed" });
  assert.deepEqual(atEnd, [undefined, 100]);
  await session.dispose();
});
