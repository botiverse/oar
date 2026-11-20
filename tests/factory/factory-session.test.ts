/* oxlint-disable import/max-dependencies -- The native control also verifies its public view. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { awaitIdle, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { ModelConfirmationError, ResumeCwdError, UnsupportedOptionError, type RawEvent, type Session } from "../../packages/oar/src/contracts/index.js";
import { createFactorySession } from "../../packages/oar/src/runtimes/factory/session.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const fakeDroid = path.resolve(import.meta.dirname, "../fixtures/fake-droid.mjs");
const open: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(async (close) => { await close(); })); });

async function session(
  mode: string,
  turnMs = 0,
  extra: { readonly resume?: string; readonly model?: string; readonly effort?: string; readonly contextReadTimeoutMs?: number; readonly contextMs?: number } = {},
): Promise<Session> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-fake-droid-"));
  const command = fakeAgentBinary(dir, [fakeDroid]);
  const { contextReadTimeoutMs, contextMs, ...sessionOptions } = extra;
  const opened = await createFactorySession({ abortFallbackMs: 300, ...(contextReadTimeoutMs === undefined ? {} : { contextReadTimeoutMs }) })({ kind: "available", via: "executable", command }, {
    cwd: dir, env: { FAKE_DROID_MODE: mode, FAKE_DROID_TURN_MS: String(turnMs), ...(contextMs === undefined ? {} : { FAKE_DROID_CONTEXT_MS: String(contextMs) }) }, ...sessionOptions,
  });
  open.push(async () => { await opened.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return opened;
}
const events = (records: readonly RawEvent[]) => records.flatMap(record => eventsOf(record));

const LATE = "11111111-0000-4000-8000-000000000001";
const endsLate = (records: readonly RawEvent[]): boolean => events(records).some(event => event.kind === "turn_ended" && event.inputId === LATE);

/** The first turn ended without the late steer; droid will run it next. */
async function missedSteer(mode = "missed-steer"): Promise<Session> {
  const opened = await session(mode, 10_000);
  const first = await opened.prompt("first");
  const steer = await opened.steer?.("late steer", { inputId: LATE });
  expect(steer?.response.body.kind).toBe("accepted");
  await awaitTurnEnd(opened, first.request.seq);
  return opened;
}

it("a steer that misses its turn's end keeps the session busy until droid's turn for it ends", async () => {
  const opened = await missedSteer();
  expect(opened.status().value.kind).toBe("running");
  const early = await opened.prompt("too early");
  expect(early.response.body).toMatchObject({ kind: "rejected", code: "busy" });
  const queued = await opened.queue("held until the steer's turn ends");
  expect(queued.response.body.kind).toBe("accepted");
  await expect.poll(() => endsLate(opened.records()), { timeout: 5000 }).toBe(true);
  await awaitIdle(opened);
  expect(heldSentAfterLateTurn(opened.records())).toBe(true);
});

function heldSentAfterLateTurn(records: readonly RawEvent[]): boolean {
  const steerEnd = records.find(record => record.kind === "frame" && endsLate([record]));
  const drained = records.find(record => record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined);
  return steerEnd !== undefined && drained !== undefined && drained.seq > steerEnd.seq;
}

it("an abort droid honors by handing the prompt back is disarmed, so a later turn is not cut short", async () => {
  const opened = await session("handback", 10_000);
  await opened.prompt("handed back");
  const abort = await opened.abort();
  expect(abort.response.body.kind).toBe("accepted");
  await expect.poll(() => events(opened.records()).some(event => event.kind === "input_dropped"), { timeout: 5000 }).toBe(true);
  await opened.prompt("next");
  // Past the 300 ms fallback; the fake ends as soon as OAR closes its stdin.
  await sleep(1500);
  expect(opened.records().some(record => record.kind === "response" && record.body.kind === "exited")).toBe(false);
});

it("opens and accepts input when a native turn end is buffered before initialization completes", async () => {
  const opened = await session("ended-at-open");
  expect(await opened.prompt("next")).toMatchObject({ kind: "accepted" });
});

it("sends held input after a handback even if no turn end follows", async () => {
  const opened = await session("handback", 10_000);
  await opened.prompt("initial");
  const queued = await opened.queue("next", { inputId: LATE });
  expect(queued.kind).toBe("accepted");
  await opened.abort();
  await expect.poll(() => opened.records().some(r => r.kind === "request" && r.body.kind === "prompt" && r.body.carries?.includes(LATE) === true), { timeout: 1500 }).toBe(true);
});

it("admits a prompt issued synchronously from a native compact refusal", async () => {
  const opened = await session("compact-refusal");
  const submitted: { prompt?: ReturnType<Session["prompt"]> } = {};
  opened.rawEvents(record => {
    if (record.kind === "frame" && record.body.type === "droid.compact_session/error") {
      submitted.prompt = opened.prompt("after");
    }
  });
  expect(await opened.compact?.()).toMatchObject({ kind: "rejected", code: "runtime_refused" });
  expect(await submitted.prompt).toMatchObject({ kind: "accepted" });
});

it("a background summary notice cannot confirm a manual request that removed nothing", async () => {
  const opened = await session("compact-zero");
  expect(await opened.compact?.()).toMatchObject({ kind: "failed", code: "not_compacted" });
  expect(opened.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "compaction_ended") : [])).toEqual([{ kind: "compaction_ended", outcome: "completed" }]);
});

it("an abort whose turn never ends stops droid after the fallback", async () => {
  const opened = await session("stuck", 10_000);
  await opened.prompt("stuck");
  await opened.abort();
  await expect.poll(() => opened.records().some(record => record.kind === "response" && record.body.kind === "exited"), { timeout: 5000 }).toBe(true);
});

it("a refused abort rolls back abortingTurn so a retry still reaches droid", async () => {
  const opened = await session("refuse-interrupt", 10_000);
  const prompt = await opened.prompt("running");
  const refused = await opened.abort();
  expect(refused.response.body).toMatchObject({ kind: "rejected", code: "runtime_refused" });
  const retried = await opened.abort();
  expect(retried.response.body).toMatchObject({ kind: "accepted" });
  expect(await awaitTurnEnd(opened, prompt.request.seq)).toEqual({ kind: "aborted" });
});

it("every native line is one record in arrival order: stray lines, a failed context read and the resume settings answer", async () => {
  const opened = await session("noisy");
  await expect.poll(() => opened.records().some(record => record.kind === "frame" && record.body.type === "droid.get_context_stats"), { timeout: 5000 }).toBe(true);
  const frames = opened.records().flatMap(record => record.kind === "frame" ? [record] : []);
  const types = frames.map(frame => frame.body.type);
  expect(types.indexOf("stdout")).toBeLessThan(types.indexOf("droid.initialize_session"));
  expect(types.indexOf("response")).toBeLessThan(types.indexOf("droid.initialize_session"));
  expect(frames.find(frame => frame.body.type === "droid.get_context_stats")?.body.native).toMatchObject({ type: "response", error: { message: "context unavailable" } });
  const resumed = await session("", 0, { resume: opened.id, model: "gpt-6.1-luna" });
  expect(resumed.records().find(record => record.kind === "frame" && record.body.type === "droid.update_session_settings")?.body).toMatchObject({ native: { type: "response", result: {} } });
});

it("a model droid would not run is a ModelConfirmationError; an effort droid refuses or clamps is an UnsupportedOptionError on effort", async () => {
  const model = await session("", 0, { model: "no-such-model" }).then(() => null, (error: unknown) => error);
  expect(model).toBeInstanceOf(ModelConfirmationError);
  expect(model).toMatchObject({ requested: "no-such-model", reported: "gpt-6.1-sol" });
  expect(model instanceof ModelConfirmationError ? model.catalogSelectorIds : "read").toBeUndefined();
  const refused = await session("", 0, { effort: "bogus" }).then(() => null, (error: unknown) => error);
  expect(refused).toBeInstanceOf(UnsupportedOptionError);
  expect(refused).toMatchObject({ option: "effort" });
});

it("a steer droid refuses in the same write as its turn's end leaves the session idle, and the refusal is a frame", async () => {
  const opened = await session("refuse-steer", 10_000);
  const first = await opened.prompt("first");
  const steer = await opened.steer?.("refused", { inputId: "22222222-0000-4000-8000-000000000001" });
  expect(steer?.response.body).toMatchObject({ kind: "rejected", code: "runtime_refused" });
  await awaitTurnEnd(opened, first.request.seq);
  const next = await opened.prompt("next");
  expect(next.response.body.kind).toBe("accepted");
  expect(opened.records().find(record => record.kind === "frame" && record.body.type === "droid.add_user_message" && record.body.responseTo === steer?.request.id)?.body)
    .toMatchObject({ native: { type: "response", error: { message: "steer refused" } } });
});

it("an abort in the gap before a missed steer's turn is disarmed when droid hands that steer back", async () => {
  const opened = await missedSteer("missed-steer-handback");
  const abort = await opened.abort();
  expect(abort.response.body.kind).toBe("accepted");
  await expect.poll(() => events(opened.records()).some(event => event.kind === "input_dropped" && event.inputId === LATE), { timeout: 5000 }).toBe(true);
  const next = await opened.prompt("newer turn");
  expect(next.response.body.kind).toBe("accepted");
  // Past the 300 ms fallback, before the steer's late cancelled end at 1.5 s.
  await sleep(1000);
  expect(opened.records().some(record => record.kind === "response" && record.body.kind === "exited")).toBe(false);
});

it("replies to add_user_message and interrupt_session are frames that name their request", async () => {
  const opened = await session("", 10_000);
  const prompt = await opened.prompt("first");
  const abort = await opened.abort();
  const frames = opened.records().flatMap(record => record.kind === "frame" ? [record.body] : []);
  expect(frames.find(frame => frame.type === "droid.add_user_message")).toMatchObject({ responseTo: prompt.request.id, native: { type: "response", id: prompt.request.id, result: {} } });
  expect(frames.find(frame => frame.type === "droid.interrupt_session")).toMatchObject({ responseTo: abort.request.id, native: { type: "response", result: {} } });
});

it("resuming a droid session saved in another directory is a ResumeCwdError naming that directory", async () => {
  const opened = await session("");
  await expect(session("other-cwd", 0, { resume: opened.id })).rejects.toMatchObject({
    constructor: ResumeCwdError, option: "cwd", reason: "other_cwd", sessionId: opened.id, savedCwd: "/saved/elsewhere",
  });
});

// oxlint-disable-next-line eslint/max-statements -- One native lifecycle and its before/after replay.
it("native working state adopts only the content after that start", async () => {
  const opened = await session("content-before-start");
  await expect.poll(() => events(opened.records()).some(event => event.kind === "turn_ended")).toBe(true);
  const records = opened.records();
  const start = records.findIndex(record => eventsOf(record).some(event => event.kind === "turn_active"));
  const before = viewOf(records.slice(0, start));
  expect(before.status.kind).toBe("idle");
  expect(before.messages).toMatchObject([{ kind: "activity", sections: [{ parts: [{ text: "outside" }] }] }]);
  const view = viewOf(records);
  expect(view.messages.map(message => message.kind)).toEqual(["activity", "turn"]);
  expect(view.messages.at(-1)).toMatchObject({ sections: [{ parts: [{ text: "inside" }] }], outcome: { kind: "completed" } });
  expect(view.status).not.toHaveProperty("activity");
});

it("awaits post-turn get_context_stats before turn_ended so contextUsage() is current immediately", async () => {
  const opened = await session("slow-context", 0, { contextReadTimeoutMs: 500, contextMs: 60 });
  const first = await opened.prompt("hello");
  await awaitTurnEnd(opened, first.request.seq);
  expect(opened.contextUsage().value).toEqual({ tokens: 50, contextWindow: 100, percent: 50 });
  const records = opened.records();
  const stats = records.findLastIndex(record => record.kind === "frame" && record.body.type === "droid.get_context_stats");
  const ended = records.findLastIndex(record => record.kind === "frame" && eventsOf(record).some(event => event.kind === "turn_ended"));
  expect(stats).toBeGreaterThan(-1);
  expect(stats).toBeLessThan(ended);
});

it("keeps previous contextUsage on post-turn get_context_stats timeout and leaves late replies raw", async () => {
  const opened = await session("slow-context", 0, { contextReadTimeoutMs: 40, contextMs: 180 });
  await expect.poll(() => opened.contextUsage().value, { timeout: 2000 }).toEqual({ tokens: 10, contextWindow: 100, percent: 10 });
  const first = await opened.prompt("hello");
  await awaitTurnEnd(opened, first.request.seq);
  expect(opened.contextUsage().value).toEqual({ tokens: 10, contextWindow: 100, percent: 10 });
  await expect.poll(() => opened.records().filter(record => record.kind === "frame" && record.body.type === "droid.get_context_stats").length, { timeout: 2000 }).toBe(2);
  expect(opened.contextUsage().value).toEqual({ tokens: 10, contextWindow: 100, percent: 10 });
});
