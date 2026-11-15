import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { awaitIdle, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { ModelConfirmationError, UnsupportedOptionError, type RawEvent, type Session } from "../../packages/oar/src/contracts/index.js";
import { createFactorySession } from "../../packages/oar/src/runtimes/factory/session.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const fakeDroid = path.resolve(import.meta.dirname, "../fixtures/fake-droid.mjs");
const open: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(async (close) => { await close(); })); });

async function session(mode: string, turnMs = 0, extra: { readonly resume?: string; readonly model?: string; readonly effort?: string } = {}): Promise<Session> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-fake-droid-"));
  const command = fakeAgentBinary(dir, [fakeDroid]);
  const opened = await createFactorySession({ abortFallbackMs: 300 })({ kind: "available", via: "executable", command }, {
    cwd: dir, env: { FAKE_DROID_MODE: mode, FAKE_DROID_TURN_MS: String(turnMs) }, ...extra,
  });
  open.push(async () => { await opened.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return opened;
}
const events = (records: readonly RawEvent[]) => records.flatMap(record => eventsOf(record));

const LATE = "11111111-0000-4000-8000-000000000001";
const endsLate = (records: readonly RawEvent[]): boolean => events(records).some(event => event.kind === "turn_ended" && event.inputId === LATE);

/** The first turn ended without the late steer; droid will run it next. */
async function missedSteer(): Promise<Session> {
  const opened = await session("missed-steer", 10_000);
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

it("an abort whose turn never ends stops droid after the fallback", async () => {
  const opened = await session("stuck", 10_000);
  await opened.prompt("stuck");
  await opened.abort();
  await expect.poll(() => opened.records().some(record => record.kind === "response" && record.body.kind === "exited"), { timeout: 5000 }).toBe(true);
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
