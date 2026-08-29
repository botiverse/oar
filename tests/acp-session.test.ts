import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Session, SessionEvent, Turn } from "../packages/oar/src/contracts/session.js";
import {
  acpSession,
  type AcpSessionProfile,
} from "../packages/oar/src/shared/acp/session.js";

const fixture = fileURLToPath(new URL("fixtures/fake-acp-agent.mjs", import.meta.url));
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

async function start(overrides: Partial<AcpSessionProfile> = {}, resume?: string): Promise<Session> {
  return acpSession(profile(overrides))(installation, {
    cwd: process.cwd(),
    ...(resume === undefined ? {} : { resume }),
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
