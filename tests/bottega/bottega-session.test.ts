/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each test drives one adapter mechanic through a scripted bottega in observable order. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { SessionNotFoundError } from "../../packages/oar/src/contracts/session-not-found-error.js";
import type { RawEvent, RuntimeEventBody, Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { bottegaRuntime } from "../../packages/oar/src/runtimes/bottega/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";

// The adapter against a scripted `bottega serve` (fake-bottega-serve.mjs): its
// own mechanics, with no bottega installed. The real one is bottega-serve.test.ts.
const installation = { kind: "available", via: "executable", command: fileURLToPath(new URL("fake-bottega-serve.mjs", import.meta.url)) } as const;
const runtime = bottegaRuntime;
const sessions: Session[] = [];
/** What a call's response said. */
async function answerOf(call: Promise<{ readonly response: { readonly body: unknown } }>): Promise<unknown> {
  const answer = await call;
  return answer.response.body;
}
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(async (session) => { await session.dispose(); }));
});

async function open(options: Partial<SessionOptions> = {}): Promise<Session> {
  const session = await runtime.session(installation, { cwd: process.cwd(), ...options });
  sessions.push(session);
  return session;
}

const eventsOf = (records: readonly RawEvent[]): RuntimeEventBody[] => records.flatMap((record) => record.kind === "frame" ? record.body.events : []);
const nativeOf = (session: Session, type: string): unknown[] => session.records().flatMap((record) => record.kind === "frame" && record.body.type === type ? [record.body.native] : []);
const STEERED = "aaaaaaaa-0000-4000-8000-000000000001";
const KEPT = "aaaaaaaa-0000-4000-8000-000000000002";
const GONE = "aaaaaaaa-0000-4000-8000-000000000003";
const acceptedAs = (outcome: { readonly response: { readonly body: unknown } }): unknown => outcome.response.body;

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  // oxlint-disable-next-line no-await-in-loop -- Polling a stream the child writes.
  while (!check() && Date.now() < deadline) { await delay(10); }
  assert.ok(check(), "the awaited state was not reached");
}

describe.skipIf(process.platform === "win32")("bottega adapter mechanics", () => {
  test("open carries the route, the level and the standing text, and the session is bottega's own", async () => {
    const session = await open({ model: "openrouter/deepseek/deepseek-v4.1-flash", effort: "low", appendSystemPrompt: "You answer to Lin." });
    expect(session.id).toBe("1112-0900-fake");
    expect(session.placement).toBe("isolated");
    expect(session.capabilities).toEqual({ queue: { durable: false }, attribution: "none", images: false });
    expect(typeof session.steer).toBe("function");
    expect(typeof session.withdraw).toBe("function");
    expect(nativeOf(session, "bottega/ready")).toEqual([{ type: "ready", protocol: 1, version: "0.0.0-fake" }]);
    expect(nativeOf(session, "bottega/opened")[0]).toMatchObject({ sessionId: session.id, asked: {
      method: "open", cwd: process.cwd(), provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinking: "low", instructions: "You answer to Lin.",
    } });
    expect(session.model().value).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    await session.dispose();
  });

  test("a person's prompt is a turn: its line, what the agent did and said, what it cost", async () => {
    const session = await open();
    const started = await session.prompt("hello");
    assert.ok(started.kind === "accepted" && started.request.body.kind === "prompt");
    const { inputId } = started.request.body;
    expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
    expect(eventsOf(session.records())).toEqual([
      { kind: "model", model: "fake/fake-1" },
      { kind: "effort", effort: "medium" },
      { kind: "user_message", input: "hello", inputId, nativeMessageId: "m1", evidence: "conversation" },
      { kind: "turn_active", inputId },
      { kind: "reasoning", content: { kind: "text", text: "thinking it over" } },
      { kind: "tool_call_started", callId: "s1.1", tool: "files_read", input: "{\"path\":\"README.md\"}" },
      { kind: "tool_call_ended", callId: "s1.1", content: [{ type: "text", text: "w3: 12 lines" }] },
      { kind: "usage", usage: { tokens: { input: 145, output: 10, cacheRead: 40, cacheWrite: 5 }, context: { tokens: 145, contextWindow: 1000, percent: 14 } } },
      { kind: "text_delta", text: "echo:hello", messageId: "m2" },
      { kind: "turn_ended", outcome: { kind: "completed" }, inputIds: [inputId] },
    ]);
    expect(session.usage().value.total).toEqual({ input: 145, output: 10, cacheRead: 40, cacheWrite: 5 });
    expect(session.contextUsage().value).toEqual({ tokens: 145, contextWindow: 1000, percent: 14 });
    expect(session.status().value.kind).toBe("idle");
    expect(session.effort().value).toBe("medium");
    await session.dispose();
  });

  test("whose input it is reaches bottega: a host's notification as an event, a person's as a line", async () => {
    const session = await open();
    const knock = await session.deliver("Inbox update: 2 unread", { origin: { kind: "notification", source: "raft" } });
    assert.ok(knock.landed === "prompted");
    expect(acceptedAs(knock.result)).toEqual({ kind: "accepted", native: { as: "event" } });
    assert.ok(knock.result.request.body.kind === "prompt");
    expect(knock.result.request.body.origin).toEqual({ kind: "notification", source: "raft" });
    await awaitTurnEnd(session, knock.result.seq);
    // A knock is no line of the conversation: nothing echoes it as the person's.
    expect(eventsOf(session.records()).filter((event) => event.kind === "user_message")).toEqual([]);
    expect(nativeOf(session, "bottega/note")).toEqual([{ type: "note", text: "(woken by raft: Inbox update: 2 unread)" }]);

    const typed = await session.prompt("hello", { origin: { kind: "user" } });
    expect(acceptedAs(typed)).toEqual({ kind: "accepted", native: { as: "line" } });
    await awaitTurnEnd(session, typed.seq);
    const plain = await session.prompt("no origin");
    expect(acceptedAs(plain)).toEqual({ kind: "accepted", native: { as: "line" } });
    await awaitTurnEnd(session, plain.seq);
    const scripted = await session.prompt("from a job", { origin: { kind: "automation", source: "ci" } });
    expect(acceptedAs(scripted)).toEqual({ kind: "accepted", native: { as: "event" } });
    await awaitTurnEnd(session, scripted.seq);
    await session.dispose();
  });

  test("an event bottega declines comes back to the host, and the session is idle again", async () => {
    const session = await open();
    const declined = await session.prompt("decline this", { origin: { kind: "notification", source: "raft" } });
    assert.ok(declined.kind === "accepted" && declined.request.body.kind === "prompt");
    const { inputId } = declined.request.body;
    expect(session.status().value.kind).toBe("running");
    expect(await awaitTurnEnd(session, declined.seq, inputId)).toMatchObject({ kind: "failed" });
    expect(eventsOf(session.records()).filter((event) => event.kind === "input_dropped")).toEqual([
      { kind: "input_dropped", reason: "runtime_refused", inputId, message: "raft: decline — not waking the agent: you stopped the agent" },
    ]);
    expect(eventsOf(session.records()).some((event) => event.kind === "turn_ended")).toBe(false);
    expect(session.status().value.kind).toBe("idle");
    const next = await session.prompt("hello");
    expect(next.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, next.seq)).toEqual({ kind: "completed" });
    await session.dispose();
  });

  test("an event given back without the id it came with still settles: the session is idle again", async () => {
    const session = await open({ env: { FAKE_BOTTEGA_ANONYMOUS_DROP: "1" } });
    const declined = await session.prompt("decline this", { origin: { kind: "notification", source: "raft" } });
    expect(declined.kind).toBe("accepted");
    await until(() => session.records().some((record) => record.kind === "frame" && record.body.type === "bottega/input_dropped"));
    expect(session.status().value.kind).toBe("idle");
    const next = await session.prompt("hello");
    expect(next.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, next.seq)).toEqual({ kind: "completed" });
    await session.dispose();
  });

  test("a held input bottega refuses when it is prompted comes back to the host as input_dropped", async () => {
    const session = await open();
    assert.ok(session.steer !== undefined);
    const first = await session.prompt("hold on");
    expect(await answerOf(session.queue("refuse this", { inputId: KEPT }))).toEqual({ kind: "accepted", queued: "adapter" });
    await until(() => eventsOf(session.records()).some((event) => event.kind === "turn_active"));
    await session.steer("release");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await until(() => eventsOf(session.records()).some((event) => event.kind === "input_dropped"));
    const dispatch = session.records().findLast((record) => record.kind === "request" && record.body.kind === "prompt");
    assert.ok(dispatch?.kind === "request");
    expect(eventsOf(session.records()).filter((event) => event.kind === "input_dropped")).toEqual([
      { kind: "input_dropped", reason: "runtime_refused", message: "scripted refusal", requestId: dispatch.id, inputId: KEPT },
    ]);
    expect(session.status().value.kind).toBe("idle");
    await session.dispose();
  });

  test("one turn at a time: a second prompt is busy, a steer joins the turn, an abort ends it", async () => {
    const session = await open();
    assert.ok(session.steer !== undefined);
    expect(await answerOf(session.steer("too early"))).toEqual({ kind: "rejected", code: "no_active_turn", reason: "no active turn" });
    expect(await answerOf(session.abort())).toEqual({ kind: "rejected", code: "no_active_turn", reason: "no active turn" });
    const first = await session.prompt("hold on");
    expect(await answerOf(session.prompt("two"))).toEqual({ kind: "rejected", code: "busy", reason: "busy" });
    await until(() => eventsOf(session.records()).some((event) => event.kind === "turn_active"));
    const steered = await session.steer("and release", { inputId: STEERED });
    expect(acceptedAs(steered)).toEqual({ kind: "accepted", native: { as: "line" } });
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    expect(eventsOf(session.records()).flatMap((event) => event.kind === "user_message" ? [event.input] : [])).toEqual(["hold on", "and release"]);

    const second = await session.prompt("hold again");
    await until(() => eventsOf(session.records()).filter((event) => event.kind === "turn_active").length === 2);
    const aborted = await session.abort();
    expect(aborted.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, second.seq)).toEqual({ kind: "aborted" });
    expect(session.status().value.kind).toBe("idle");
    await session.dispose();
  });

  test("a queued input is held here, can be taken back, and is prompted when the turn ends", async () => {
    const session = await open();
    assert.ok(session.steer !== undefined && session.withdraw !== undefined);
    const first = await session.prompt("hold on");
    const kept = await session.queue("after that", { inputId: KEPT, origin: { kind: "notification", source: "raft" } });
    expect(kept.response.body).toEqual({ kind: "accepted", queued: "adapter" });
    const dropped = await session.queue("never mind", { inputId: GONE });
    expect(dropped.kind).toBe("accepted");
    expect(await answerOf(session.withdraw(GONE))).toEqual({ kind: "accepted" });
    expect(await answerOf(session.withdraw(GONE))).toMatchObject({ kind: "rejected", code: "not_queued" });
    await until(() => eventsOf(session.records()).some((event) => event.kind === "turn_active"));
    await session.steer("release");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await until(() => eventsOf(session.records()).filter((event) => event.kind === "turn_ended").length === 2);
    const prompts = session.records().flatMap((record) => record.kind === "request" && record.body.kind === "prompt" ? [record.body] : []);
    expect(prompts.at(-1)).toEqual({ kind: "prompt", input: "after that", carries: [KEPT], origin: { kind: "notification", source: "raft" } });
    // The held input kept whose it was: bottega took it as an event.
    expect(nativeOf(session, "bottega/note").at(-1)).toEqual({ type: "note", text: "(woken by raft: after that)" });
    expect(session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" } });
    await session.dispose();
  });

  test("a held input's prompt goes to bottega with its input id, and the turn it starts says so", async () => {
    const session = await open();
    assert.ok(session.steer !== undefined);
    const first = await session.prompt("hold on");
    expect(await answerOf(session.queue("after that", { inputId: KEPT }))).toEqual({ kind: "accepted", queued: "adapter" });
    await until(() => eventsOf(session.records()).some((event) => event.kind === "turn_active"));
    await session.steer("release");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await until(() => eventsOf(session.records()).filter((event) => event.kind === "turn_ended").length === 2);
    const events = eventsOf(session.records());
    expect(events.find((event) => event.kind === "user_message" && event.input === "after that")).toMatchObject({ inputId: KEPT });
    expect(events.findLast((event) => event.kind === "turn_active")).toEqual({ kind: "turn_active", inputId: KEPT });
    expect(events.findLast((event) => event.kind === "turn_ended")).toMatchObject({ inputIds: [KEPT] });
    await session.dispose();
  });

  test("a failed turn and one stopped at the step limit are failures with bottega's own words", async () => {
    const session = await open();
    const failed = await session.prompt("fail now");
    expect(await awaitTurnEnd(session, failed.seq)).toEqual({ kind: "failed", failure: "unknown", reason: "the agent hit an error: inference error: scripted" });
    const capped = await session.prompt("cap now");
    expect(await awaitTurnEnd(session, capped.seq)).toEqual({ kind: "failed", failure: "limit_reached", reason: "stopped at 30 steps, the most one message gives it, before it finished its turn" });
    await session.dispose();
  });

  test("resume takes the same session up, or says loudly that it cannot", async () => {
    const resumed = await open({ resume: "1112-0900-fake", appendSystemPrompt: "new standing text", effort: "high" });
    expect(resumed.id).toBe("1112-0900-fake");
    expect(nativeOf(resumed, "bottega/opened")[0]).toMatchObject({ asked: { method: "resume", sessionId: "1112-0900-fake", cwd: process.cwd(), instructions: "new standing text", thinking: "high" } });
    expect(resumed.effort().value).toBe("high");
    await resumed.dispose();
    await expect(open({ resume: "missing" })).rejects.toBeInstanceOf(SessionNotFoundError);
    // A saved session keeps its route: asking for another is refused, never run on the old one in silence.
    await expect(open({ resume: "1112-0900-fake", model: "openrouter/another" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "model" });
    await expect(open({ resume: "1112-0900-fake", model: "fake/fake-1" })).resolves.toMatchObject({ id: "1112-0900-fake" });
  });

  test("a level bottega does not have and a protocol this adapter does not speak both fail the open", async () => {
    await expect(open({ effort: "galactic" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "effort" });
    await expect(open({ env: { FAKE_BOTTEGA_PROTOCOL: "2" } })).rejects.toThrow(/spoke protocol 2, not 1/u);
  });

  test("dispose is recorded once, answered by the exit, and ends control", async () => {
    const session = await open();
    await Promise.all([session.dispose(), session.dispose()]);
    const records = session.records();
    const disposals = records.filter((record) => record.kind === "request" && record.body.kind === "dispose");
    expect(disposals).toHaveLength(1);
    const [dispose] = disposals;
    assert.ok(dispose?.kind === "request");
    expect(records.some((record) => record.kind === "response" && record.requestId === dispose.id && record.body.kind === "exited")).toBe(true);
    expect(await answerOf(session.prompt("after"))).toMatchObject({ kind: "rejected" });
    await session.dispose();
  });

});
