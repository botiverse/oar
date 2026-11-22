import { afterEach, expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import type { Event, Session } from "../../packages/oar/src/contracts/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { createKapTestFixture, finishAndDispose, randomUUID, waitTurnStarted, waitUntil, type KapTestFixture } from "../fixtures/kimi-kap-support.js";

const cleanups: (() => void)[] = [];

function useFixture(): KapTestFixture {
  const fx = createKapTestFixture();
  cleanups.push(() => { fx.cleanup(); });
  return fx;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function postedPrompts(fx: KapTestFixture): string[] {
  return fx.readLog()
    .filter((entry) => entry.method === "POST" && typeof entry.url === "string" && entry.url.endsWith("/prompts"))
    .map((entry) => JSON.stringify(entry.body));
}

async function openAndRunDelayedFirst(fx: KapTestFixture): Promise<void> {
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_SCENARIO: "delayed_initial_turns" } });
  const events: Event[] = [];
  session.events((ev) => { events.push(ev); });
  const first = await session.prompt("FIRST_AFTER_DELAY");
  expect(first.response.body.kind).toBe("accepted");
  await waitUntil(() => session.status().value.kind === "idle", "first turn idle");
  const second = await session.prompt("SECOND_AFTER_DELAY");
  expect(second.response.body.kind).toBe("accepted");
  await finishAndDispose(session, "delayed turns second prompt");
  expect(events.some((ev) => ev.kind === "text_delta" && ev.text.includes("FIRST_AFTER_DELAY"))).toBe(true);
}

test("waits for initial root turns boundary before opening and rejects turns.failed on open", async () => {
  const fx = useFixture();
  await openAndRunDelayedFirst(fx);
  await expect(fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_SCENARIO: "turns_failed_on_open" } })).rejects.toThrow(/Failed to load initial turns/iu);
});

test("requires positive effort confirmation when agent snapshot omits thinking", async () => {
  const fx = useFixture();
  await expect(
    fx.open("2.7.2-botiverse.1", { effort: "high", env: { FAKE_KIMI_SCENARIO: "omit_effort" } }),
  ).rejects.toThrow(UnsupportedOptionError);
});

async function assertSlowCompactionQueue(session: Session, fx: KapTestFixture, events: Event[]): Promise<void> {
  const outcome = await session.compact?.({ timeoutMs: 25 });
  expect(outcome?.kind).toBe("unconfirmed");
  const queued = await session.queue("AFTER_COMPACT", { inputId: randomUUID() });
  const blocked = await session.prompt("BLOCKED_WHILE_COMPACTING");
  const blockedSteer = await session.steer?.("STEER_WHILE_COMPACTING");
  expect([queued.response.body, blocked.response.body, blockedSteer?.response.body]).toEqual([
    expect.objectContaining({ kind: "accepted", queued: "adapter" }),
    expect.objectContaining({ kind: "rejected", code: "busy" }),
    expect.objectContaining({ kind: "rejected", code: "busy" }),
  ]);
  expect(postedPrompts(fx)).toEqual([]);
  await finishAndDispose(session, "post-compaction queued turn");
  expect(events.some((ev) => ev.kind === "text_delta" && ev.text.includes("reply:AFTER_COMPACT"))).toBe(true);
}

test("holds queue and direct prompts through unconfirmed compaction, then drains on release", async () => {
  const fx = useFixture();
  const events: Event[] = [];
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_SCENARIO: "slow_compact", FAKE_KIMI_LOG: fx.logFile } });
  session.events((ev) => { events.push(ev); });
  await assertSlowCompactionQueue(session, fx, events);
});

test("rejects compact while a prompt is active or awaiting its first frame", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  const pending = session.prompt("HOLD_FOR_CONTROLS", { inputId: randomUUID() });
  const compactResult = await session.compact?.();
  expect(compactResult).toMatchObject({ kind: "rejected", code: "busy" });
  await pending;
  await session.steer?.("release");
  await finishAndDispose(session, "compact busy cleanup");
});

test("rejects controls and settles session when WebSocket closes unexpectedly", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  await session.stopTask?.("__drop_ws__");
  await waitUntil(() => session.records().some((r) => r.kind === "response" && r.body.kind === "exited"), "session exited after unexpected WS close");
  const afterPrompt = await session.prompt("AFTER_DROP");
  const afterQueue = await session.queue("Q_AFTER_DROP");
  const afterCompact = await session.compact?.();
  expect([session.status().value.kind, afterPrompt.response.body, afterQueue.response.body, afterCompact]).toEqual([
    "idle",
    expect.objectContaining({ kind: "rejected", code: "runtime_exited" }),
    expect.objectContaining({ kind: "rejected", code: "runtime_exited" }),
    expect.objectContaining({ kind: "rejected", code: "runtime_exited" }),
  ]);
  await session.dispose();
});

test("settles active turn when WebSocket closes mid-turn", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  await session.prompt("DROP_WS_MID_TURN");
  await waitUntil(() => session.records().some((r) => r.kind === "response" && r.body.kind === "exited"), "mid-turn unexpected WS drop exit");
  expect(session.status().value).toMatchObject({ kind: "idle", lastTurnOutcome: { kind: "failed", failure: "runtime_exited" } });
  await session.dispose();
});

async function runChainedSteer(input: {
  readonly session: Session;
  readonly fx: KapTestFixture;
  readonly events: Event[];
  readonly parentPromptId: string;
}): Promise<string[]> {
  await input.session.prompt("HOLD_FOR_CONTROLS", { inputId: input.parentPromptId });
  await waitTurnStarted(input.session, "initial held turn");
  await input.session.queue("QUEUED_AFTER_STEER", { inputId: randomUUID() });
  await input.session.steer?.("STEER_FIRST HOLD_STEER");
  await waitUntil(
    () => input.session.records().some((r) => r.kind === "frame" && asRecord(asRecord(r.body.native)?.turn)?.steered_from_prompt_id === input.parentPromptId),
    "first steer turn.started with parent prompt correlation",
  );
  expect(postedPrompts(input.fx).some((body) => body.includes("QUEUED_AFTER_STEER"))).toBe(false);
  await input.session.steer?.("STEER_SECOND");
  await finishAndDispose(input.session, "chained steer + queued turn");
  return input.events.filter((ev) => ev.kind === "text_delta").map((ev) => ev.text);
}

test("keeps queued input held across chained steer continuations and inter-turn gaps", async () => {
  const fx = useFixture();
  const events: Event[] = [];
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  session.events((ev) => { events.push(ev); });
  const texts = await runChainedSteer({ session, fx, events, parentPromptId: randomUUID() });
  expect(texts.indexOf("reply:STEER_SECOND")).toBeGreaterThanOrEqual(0);
  expect(texts.indexOf("reply:QUEUED_AFTER_STEER")).toBeGreaterThan(texts.indexOf("reply:STEER_SECOND"));
});

async function runNoUserMsgSteer(session: Session, events: Event[]): Promise<string[]> {
  await session.prompt("HOLD_FOR_CONTROLS", { inputId: randomUUID() });
  await waitTurnStarted(session, "held parent before no-user-msg steer");
  await session.queue("QUEUED_AFTER_NO_USER_MSG", { inputId: randomUUID() });
  await session.steer?.("NO_STEER_USER_MSG");
  await finishAndDispose(session, "no-user-msg steer drain");
  return events.filter((ev) => ev.kind === "text_delta").map((ev) => ev.text);
}

test("releases queued input when steered successor correlates via parent IDs without user_message", async () => {
  const fx = useFixture();
  const events: Event[] = [];
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  session.events((ev) => { events.push(ev); });
  const texts = await runNoUserMsgSteer(session, events);
  expect(texts.indexOf("reply:QUEUED_AFTER_NO_USER_MSG")).toBeGreaterThan(texts.indexOf("reply:NO_STEER_USER_MSG"));
});

async function assertInitialRunningTurn(session: Session): Promise<void> {
  expect(session.status().value.kind).toBe("running");
  const pBusy = await session.prompt("SECOND_PROMPT");
  const cBusy = await session.compact?.();
  const aborted = await session.abort();
  expect([pBusy.response.body, cBusy, aborted.response.body]).toEqual([
    expect.objectContaining({ kind: "rejected", code: "busy" }),
    expect.objectContaining({ kind: "rejected", code: "busy" }),
    expect.objectContaining({ kind: "accepted" }),
  ]);
  await waitUntil(() => session.status().value.kind === "idle", "initial running turn aborted to idle");
  const pNext = await session.prompt("AFTER_ABORT");
  expect(pNext.response.body.kind).toBe("accepted");
  await finishAndDispose(session, "follow-up after initial running turn abort");
}

test("adopts running root turn from initial snapshot for busy gating and abort", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_SCENARIO: "initial_running_turn", FAKE_KIMI_LOG: fx.logFile } });
  await assertInitialRunningTurn(session);
});

test("keeps pending root start active when a child turn ends first", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_LOG: fx.logFile } });
  const pFirst = await session.prompt("CHILD_END_BEFORE_START");
  await waitUntil(
    () => session.records().some((r) => r.kind === "frame" && r.body.type === "turn.ended" && asRecord(r.body.native)?.agent_id === "agent-child-1"),
    "child turn.ended before root turn.started",
  );
  const pSecond = await session.prompt("SECOND_SHOULD_REJECT_BUSY");
  expect([pFirst.response.body.kind, pSecond.response.body]).toEqual(["accepted", expect.objectContaining({ kind: "rejected", code: "busy" })]);
  await finishAndDispose(session, "root turn completion after early child turn end");
});

async function assertCancelFalsePreservesTurn(session: Session): Promise<void> {
  await session.prompt("HOLD_FOR_CONTROLS", { inputId: randomUUID() });
  const aborted = await session.abort();
  expect(aborted.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn", native: { cancelled: false } });
  await session.steer?.("release");
  await waitUntil(
    () => session.records().some((r) => r.kind === "frame" && r.body.events.some((ev) => ev.kind === "text_delta" && ev.text === "reply:release")) &&
      session.status().value.kind === "idle",
    "held turn and steer release idle",
  );
  const nextTurn = await session.prompt("SURVIVED");
  expect(nextTurn.response.body.kind).toBe("accepted");
  await finishAndDispose(session, "follow-up after cancelled:false refusal");
}

test("disarms fallback and rejects no_active_turn when KAP returns cancelled: false", async () => {
  const fx = useFixture();
  const session = await fx.open("2.7.2-botiverse.1", { env: { FAKE_KIMI_SCENARIO: "cancel_false", FAKE_KIMI_LOG: fx.logFile } });
  await assertCancelFalsePreservesTurn(session);
});
