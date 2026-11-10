/* oxlint-disable max-statements -- Each case pins one native interjection or own-turn sequence end to end. */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { RawEvent, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, promptAndWait, statusOf } from "../../packages/oar/src/observe/index.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fixture, profile, start } from "../fixtures/acp-session-support.js";

const grok = async (): Promise<Session> => start({ ...grokAcpProfile, ...profile({ args: [fixture, "grok-native"] }) });
const events = (records: readonly RawEvent[]) => records.flatMap((record) => record.kind === "frame" ? record.body.events : []);
const ends = (records: readonly RawEvent[]) => events(records).filter((event) => event.kind === "turn_ended");
const texts = (records: readonly RawEvent[]) => events(records).flatMap((event) => event.kind === "text_delta" ? [event.text] : []);
const until = async (check: () => boolean): Promise<void> => { await vi.waitFor(() => { expect(check()).toBe(true); }, { timeout: 2000, interval: 10 }); };

test("a steer is an interjection into the running turn, which ends once with its own answer", async () => {
  const session = await grok();
  try {
    const steerId = randomUUID();
    const started = await session.prompt("hold");
    const steered = await session.steer?.("also this", { inputId: steerId });
    expect(steered?.kind).toBe("accepted");
    await awaitTurnEnd(session, started.seq);
    const records = session.records();
    const interject = records.find((record) => record.kind === "frame" && record.body.type === "_x.ai/interject");
    expect(interject).toMatchObject({ body: { native: { result: { status: "queued" } } } });
    expect(interject?.kind === "frame" ? interject.body.responseTo : undefined).toBe(steered?.requestId);
    expect(ends(records)).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    expect(texts(records)).toContain("took:also this");
    // Grok's echo is recorded; the interjection never names a turn of its own.
    expect(records.some((record) => record.kind === "frame" && record.body.type === "_x.ai/session/interjection"
      && asRecord(record.body.native)?.interjectionId === steerId)).toBe(true);
    expect(statusOf(records, session.id).value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test("each OAR prompt is named, and Grok's queue says when it waits and starts", async () => {
  const session = await grok();
  try {
    const inputId = randomUUID();
    await promptAndWait(session, "hello", { inputId });
    const queue = session.records().find((record) => record.kind === "frame" && record.body.type === "_x.ai/queue/changed");
    const entries = asRecord(queue?.kind === "frame" ? queue.body.native : null)?.entries;
    expect(Array.isArray(entries) ? asRecord(entries[0])?.id : null).toMatch(/^oar-[0-9a-f-]{36}$/u);
    expect(events(session.records()).filter((event) => event.kind === "input_queued" || event.kind === "turn_active"))
      .toEqual([{ kind: "input_queued", inputId }, { kind: "turn_active", inputId }]);
  } finally { await session.dispose(); }
});

test("an idle session has nothing to steer: no interjection is sent", async () => {
  const session = await grok();
  try {
    expect(await session.steer?.("nothing running")).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(session.records().some((record) => record.kind === "frame" && record.body.type.startsWith("_x.ai/interject"))).toBe(false);
  } finally { await session.dispose(); }
});

test("Grok's own turn is a turn: it starts, takes a steer, ends, bills, and only then lets input through", async () => {
  const session = await grok();
  try {
    await promptAndWait(session, "wake");
    await until(() => texts(session.records()).includes("woke"));
    expect(statusOf(session.records(), session.id).value.kind).toBe("running");
    expect(await session.prompt("not now")).toMatchObject({ kind: "rejected", code: "busy" });
    const queued = await session.queue("after the wake", { inputId: randomUUID() });
    expect(queued.kind).toBe("accepted");
    expect(await session.steer?.("for the wake")).toMatchObject({ kind: "accepted" });
    await until(() => texts(session.records()).includes("echo:after the wake"));
    const records = session.records();
    expect(ends(records)).toHaveLength(3);
    const own = records.findIndex((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_active" && event.inputId === undefined));
    expect(own).toBeGreaterThan(-1);
    expect(texts(records).indexOf("took:for the wake")).toBeLessThan(texts(records).indexOf("echo:after the wake"));
    expect(session.usage().value).toMatchObject({ total: { input: 10, output: 1 } });
    await until(() => statusOf(session.records(), session.id).value.kind === "idle");
  } finally { await session.dispose(); }
});

test("an interjection that misses Grok's final drain runs as Grok's own turn, inside the open prompt turn", async () => {
  const session = await grok();
  try {
    const started = await session.prompt("late-drain");
    expect(await session.steer?.("late")).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "completed" });
    const records = session.records();
    expect(texts(records)).toEqual(["echo:late-drain", "took:late"]);
    expect(ends(records)).toHaveLength(1);
    expect(statusOf(records, session.id).value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test("Grok's next turn racing the prompt answer stays inside that prompt's turn", async () => {
  const session = await grok();
  try {
    expect(await promptAndWait(session, "race")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const records = session.records();
    expect(ends(records)).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    expect(texts(records)).toEqual(["echo:race", "woke-race"]);
    expect(statusOf(records, session.id).value.kind).toBe("idle");
    expect(await promptAndWait(session, "next")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  } finally { await session.dispose(); }
});

test("abort clears a buffered interjection: the turn is aborted and nothing runs after it", async () => {
  const session = await grok();
  try {
    const started = await session.prompt("hold-buffer");
    expect(await session.steer?.("never seen", { inputId: randomUUID() })).toMatchObject({ kind: "accepted" });
    expect(await session.abort()).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "aborted" });
    await delay(50);
    const records = session.records();
    expect(ends(records)).toHaveLength(1);
    // Whether Grok had already taken the input is not reported: no drop is claimed.
    expect(events(records).some((event) => event.kind === "input_dropped")).toBe(false);
  } finally { await session.dispose(); }
});

test("Grok's own turn can be stopped: abort cancels it and its own end is aborted", async () => {
  const session = await grok();
  try {
    await promptAndWait(session, "wake");
    await until(() => statusOf(session.records(), session.id).value.kind === "running");
    const stopped = await session.abort();
    expect(stopped.kind).toBe("accepted");
    await until(() => statusOf(session.records(), session.id).value.kind === "idle");
    expect(ends(session.records()).at(-1)).toEqual({ kind: "turn_ended", outcome: { kind: "aborted" } });
    expect(await promptAndWait(session, "after the stop")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  } finally { await session.dispose(); }
});

test("a Grok turn that outlives the prompt answer it overlapped is still running after that answer", async () => {
  const session = await grok();
  try {
    expect(await promptAndWait(session, "race-long")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(statusOf(session.records(), session.id).value.kind).toBe("running");
    expect(await session.prompt("too soon")).toMatchObject({ kind: "rejected", code: "busy" });
    await until(() => statusOf(session.records(), session.id).value.kind === "idle");
    expect(ends(session.records())).toHaveLength(2);
    expect(await promptAndWait(session, "now")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  } finally { await session.dispose(); }
});
