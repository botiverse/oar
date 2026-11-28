/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each test plays one exchange with the real bottega in order, against what its model was sent. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { RawEvent, RuntimeEventBody, Session, SessionOptions, TurnOutcome } from "../../packages/oar/src/contracts/session.js";
import { bottegaRuntime } from "../../packages/oar/src/runtimes/bottega/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import type { LLMock } from "../../sea-trial/harness/aimock.js";
import { BOTTEGA_AIMOCK_ROUTE, startBottegaAimock, type BottegaAimock } from "../../sea-trial/harness/bottega-aimock.js";

// The real `bottega serve` (OAR_BOTTEGA_BIN names it) behind the adapter, with
// only the model provider scripted: what each kind of input becomes on the
// screen the model is sent, and how bottega's own rules for turns the world
// starts meet a host that prompts. Skipped where no bottega is named.
const enabled = process.env.OAR_BOTTEGA_BIN !== undefined && process.platform !== "win32";
const runtime = bottegaRuntime;
const RAFT = { kind: "notification", source: "raft" } as const;

interface ProviderRequest {
  readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
  readonly reasoning_effort?: string;
}
/** A message's text, whether the provider was sent a string or text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") { return content; }
  if (!Array.isArray(content)) { return JSON.stringify(content); }
  return content.map((part: unknown) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}
/** The standing prompt of a request, and the screen: every message after it. */
const systemOf = (request: ProviderRequest): string => (request.messages ?? []).filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content)).join("\n");
const screenOf = (request: ProviderRequest): string => (request.messages ?? []).filter((message) => message.role === "user").map((message) => textOf(message.content)).join("\n");
const eventsOf = (records: readonly RawEvent[]): RuntimeEventBody[] => records.flatMap((record) => record.kind === "frame" ? record.body.events : []);
const textField = (native: unknown): string => typeof native === "object" && native !== null && "text" in native && typeof native.text === "string" ? native.text : "";
const notesOf = (session: Session): string[] => session.records().flatMap((record) => record.kind === "frame" && record.body.type === "bottega/note" ? [textField(record.body.native)] : []);

interface Fixture {
  readonly aimock: BottegaAimock;
  readonly requests: ProviderRequest[];
  readonly open: (options?: Partial<SessionOptions>) => Promise<Session>;
}

async function withBottega(body: (fixture: Fixture) => Promise<void>, latency = 20): Promise<void> {
  const requests: ProviderRequest[] = [];
  const aimock = await startBottegaAimock((mock: LLMock) => {
    mock.onMessage(/slow/u, (request: ProviderRequest) => { requests.push(request); return { content: "ok" }; }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, (request: ProviderRequest) => { requests.push(request); return { content: "ok" }; }, { latency });
  });
  const sessions: Session[] = [];
  try {
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available", `bottega is not installed: ${JSON.stringify(installation)}`);
    await body({ aimock, requests, open: async (options = {}) => {
      const session = await runtime.session(installation, { cwd: aimock.cwd, model: BOTTEGA_AIMOCK_ROUTE, ...options, env: { ...aimock.env, ...options.env } });
      sessions.push(session);
      return session;
    } });
  } finally {
    await Promise.allSettled(sessions.map(async (session) => { await session.dispose(); }));
    await aimock.stop();
  }
}

/** A host's notification, and how its input settled: a turn's end, or the drop that handed it back. */
async function knock(session: Session, text: string): Promise<TurnOutcome> {
  const inputId = randomUUID();
  const delivered = await session.deliver(text, { origin: RAFT, inputId });
  assert.ok(delivered.landed === "prompted", JSON.stringify(delivered));
  const settled = await awaitTurnEnd(session, delivered.result.seq, inputId);
  assert.ok(settled.kind !== "handled");
  return settled;
}

describe.skipIf(!enabled)("bottega serve behind the adapter", () => {
  test("the installation is the named executable, with bottega's own version", async () => {
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available" && installation.via === "executable", JSON.stringify(installation));
    expect(installation.command).toBe(process.env.OAR_BOTTEGA_BIN);
    expect(installation.version).toMatch(/^\d+\.\d+\.\d+/u);
  }, 30_000);

  test("a person's input is a line of the conversation; a host's notification is an event, the app it is signed by turned on", async () => {
    await withBottega(async ({ open, requests }) => {
      const session = await open();
      const typed = await session.prompt("please look at the plan", { origin: { kind: "user" } });
      assert.ok(typed.kind === "accepted" && typed.request.body.kind === "prompt");
      expect(await awaitTurnEnd(session, typed.seq)).toEqual({ kind: "completed" });
      expect(screenOf(requests[0] ?? {})).toMatch(/w\d+ chat [^\n]*\n(?:[^\n]*\n)*?[^\n]*user: please look at the plan/u);
      expect(eventsOf(session.records()).filter((event) => event.kind === "user_message")).toEqual([
        { kind: "user_message", input: "please look at the plan", inputId: typed.request.body.inputId, nativeMessageId: "m1", evidence: "conversation" },
      ]);

      const before = requests.length;
      // Raft's daemon's own words for a wake, at the instant Raft's list has not counted the message yet.
      const notice = "[Raft inbox notice: Inbox update: 1 message pending your read across all conversations; 1 changed target\n" +
        "#eng  pending: 1 message · first msg=b2b9b570 · latest sender @ana · latest msg=b2b9b570 · you were mentioned\n" +
        "  latest @ana: \"the Top50 list by 17:00\" (preview; still unread, full text: raft message read --target \"#eng\" --unread)\n" +
        "]\nThese messages have not been read.";
      expect(await knock(session, notice)).toEqual({ kind: "completed" });
      const screen = screenOf(requests[before] ?? {});
      // The Raft app came on for it and lists what it named; the conversation gained nothing.
      expect(notesOf(session)).toContain("(raft is on: its events are read there)");
      expect(screen).toMatch(/inbox: 1 item waiting/u);
      expect(screen).toMatch(/#eng {2}1 unread {2}@ana \(mentions you\)/u);
      expect(screen).not.toMatch(/user: \[Raft inbox notice/u);
      expect(eventsOf(session.records()).filter((event) => event.kind === "user_message")).toHaveLength(1);
    });
  }, 60_000);

  test("the host's standing text and effort: a resume that gives them changes them, one that omits them keeps the saved ones", async () => {
    await withBottega(async ({ open, requests }) => {
      const first = await open({ appendSystemPrompt: "OAR-APPEND-ONE", effort: "low" });
      expect(first.effort().value).toBe("low");
      const hello = await first.prompt("remember the blue door");
      await awaitTurnEnd(first, hello.seq);
      expect(systemOf(requests[0] ?? {})).toMatch(/# Task-specific instructions\s+OAR-APPEND-ONE$/u);
      expect(requests[0]?.reasoning_effort).toBe("low");
      const { id } = first;
      await first.dispose();

      const before = requests.length;
      const resumed = await open({ resume: id, appendSystemPrompt: "OAR-APPEND-TWO", effort: "high" });
      expect(resumed.id).toBe(id);
      expect(resumed.effort().value).toBe("high");
      const again = await resumed.prompt("hello again");
      expect(await awaitTurnEnd(resumed, again.seq)).toEqual({ kind: "completed" });
      const request = requests[before] ?? {};
      expect(systemOf(request)).toMatch(/OAR-APPEND-TWO$/u);
      expect(systemOf(request)).not.toMatch(/OAR-APPEND-ONE/u);
      expect(request.reasoning_effort).toBe("high");
      // The session itself came back: its conversation is on the screen.
      expect(screenOf(request)).toMatch(/user: remember the blue door/u);
      expect(screenOf(request)).toMatch(/user: hello again/u);
      await resumed.dispose();

      const later = requests.length;
      const kept = await open({ resume: id });
      expect(kept.effort().value).toBe("high");
      const third = await kept.prompt("and once more");
      expect(await awaitTurnEnd(kept, third.seq)).toEqual({ kind: "completed" });
      expect(systemOf(requests[later] ?? {})).toMatch(/OAR-APPEND-TWO$/u);
      expect(requests[later]?.reasoning_effort).toBe("high");
    });
  }, 60_000);

  test("a steer reaches the running turn's next step as the person's line", async () => {
    await withBottega(async ({ open, requests }) => {
      const session = await open();
      assert.ok(session.steer !== undefined);
      const started = await session.prompt("start slow");
      const steered = await session.steer("mid-turn note");
      expect(steered.kind).toBe("accepted");
      expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
      expect(requests.some((request) => /user: mid-turn note/u.test(screenOf(request)))).toBe(true);
      expect(eventsOf(session.records()).filter((event) => event.kind === "turn_ended")).toHaveLength(1);
    });
  }, 60_000);

  test("after an abort bottega starts no turn for the host until a person speaks: the notification comes back", async () => {
    await withBottega(async ({ open }) => {
      const session = await open();
      const started = await session.prompt("start slow");
      await delay(300);
      const aborted = await session.abort();
      expect(aborted.kind).toBe("accepted");
      expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "aborted" });

      const declined = await knock(session, "Inbox update: one more");
      expect(declined).toMatchObject({ kind: "failed" });
      const dropped = eventsOf(session.records()).filter((event) => event.kind === "input_dropped");
      expect(dropped).toHaveLength(1);
      const [refused] = dropped;
      assert.ok(refused?.kind === "input_dropped" && refused.reason === "runtime_refused");
      expect(refused.message).toContain("not waking the agent: you stopped the agent");
      expect(session.status().value.kind).toBe("idle");

      // A person's line lifts it, and the host is heard again.
      const typed = await session.prompt("carry on");
      expect(await awaitTurnEnd(session, typed.seq)).toEqual({ kind: "completed" });
      expect(await knock(session, "Inbox update: after that")).toEqual({ kind: "completed" });
    });
  }, 60_000);

  test("the host starts as many turns in a row as it sends notifications", async () => {
    await withBottega(async ({ open }) => {
      const session = await open();
      const outcomes: string[] = [];
      // Past bottega's desktop bound of ten: a served session leaves the rule to its host.
      for (let index = 1; index <= 12; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- One notification at a time, in order.
        const outcome = await knock(session, `Inbox update ${String(index)}`);
        outcomes.push(outcome.kind);
      }
      expect(outcomes).toEqual(Array.from({ length: 12 }, () => "completed"));
      expect(eventsOf(session.records()).filter((event) => event.kind === "input_dropped")).toEqual([]);
    });
  }, 120_000);
});
