/* oxlint-disable eslint/max-statements -- Each restore case follows one whole flow: a held input, its snapshot, the reopened session and the resend it does or does not make. */
import { expect, test } from "vitest";
import type { ControlOutcome, InputOptions } from "../packages/oar/src/contracts/session.js";
import {
  queueSnapshotOf,
  queueSnapshotPlan,
  restoreQueue,
  type QueueRestoreSession,
  type QueueSnapshot,
  type QueueSnapshotTarget,
} from "../packages/oar/src/observe/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import {
  OTHER_INPUT,
  SECOND_INPUT,
  SESSION,
  SNAPSHOT_INPUT,
  STREAM,
  THIRD_INPUT,
  accepted,
  childQueue,
  prompt,
  queue,
  rejected,
  withdraw,
} from "./fixtures/queue-records.js";

/**
 * The restore plan and the restore call (docs/spec/queue-snapshot.md). The
 * invariant: a reopened session gets a second copy only of an input the stream
 * returned to the caller, and every other entry is reported with its reason.
 */

const snapshotOf = (records: Parameters<typeof queueSnapshotOf>[0]): QueueSnapshot => queueSnapshotOf(records, { streamId: STREAM, sessionId: SESSION });
const heldQueue = (): QueueSnapshot => snapshotOf([queue(0, "rq-1"), accepted(1, "rq-1", "adapter")]);
const withdrawn = (): QueueSnapshot => snapshotOf([queue(0, "rq-1"), accepted(1, "rq-1", "adapter"), withdraw(2, "rq-2"), accepted(3, "rq-2")]);
const reopened = (overrides: Partial<QueueSnapshotTarget> = {}): QueueSnapshotTarget => ({ sessionId: SESSION, streamId: "stream-2", records: [], ...overrides });
const acceptedOutcome = (seq: number, id: string): ControlOutcome => ({ kind: "accepted", seq, requestId: id, request: queue(seq, id), response: accepted(seq + 1, id) });

function recorder(): { readonly session: QueueRestoreSession; readonly calls: { readonly input: string; readonly options: InputOptions | undefined }[] } {
  const calls: { readonly input: string; readonly options: InputOptions | undefined }[] = [];
  const session: QueueRestoreSession = {
    id: SESSION,
    queue: async (input, options) => {
      calls.push({ input, options });
      return acceptedOutcome(calls.length, `rq-${String(calls.length)}`);
    },
  };
  return { session, calls };
}

test("a new stream on the same native session is restorable: a withdrawn input is planned, a held queue is not", () => {
  expect(queueSnapshotPlan(heldQueue(), reopened())).toMatchObject({ status: "ready", resends: 0, entries: [{ resend: false, code: "held_by_oar" }] });
  expect(queueSnapshotPlan(withdrawn(), reopened())).toMatchObject({ status: "ready", resends: 1, entries: [{ resend: true, inputId: SNAPSHOT_INPUT }] });
});

test("another native session is foreign, and nothing is resent", () => {
  expect(queueSnapshotPlan(withdrawn(), reopened({ sessionId: "other" }))).toMatchObject({
    status: "blocked",
    blocked: { code: "foreign_session" },
    resends: 0,
    entries: [{ resend: false, code: "plan_blocked" }],
  });
});

test("a checkpoint of the same stream is current, and a snapshot ahead of that stream is stale", () => {
  const snapshot = withdrawn();
  const current = queueSnapshotPlan(snapshot, reopened({ streamId: STREAM, records: [accepted(3, "rq-2")] }));
  expect(current).toMatchObject({ status: "current", resends: 0, entries: [{ resend: false, code: "already_current" }] });
  // The stream names itself without handing over its records: the same fold stream, so nothing to restore.
  expect(queueSnapshotPlan(snapshot, { sessionId: SESSION, streamId: STREAM })).toMatchObject({ status: "current", resends: 0 });
  const stale = queueSnapshotPlan(snapshot, reopened({ streamId: STREAM, records: [queue(0, "rq-1")] }));
  expect(stale).toMatchObject({ status: "blocked", blocked: { code: "stale_snapshot" }, resends: 0 });
});

test("an input the target stream already names is a duplicate, not a second send; another lane is not", () => {
  const claimed = queueSnapshotPlan(withdrawn(), reopened({ records: [queue(0, "rq-9")] }));
  expect(claimed).toMatchObject({ resends: 0, entries: [{ resend: false, code: "duplicate_input" }] });
  const otherLane = queueSnapshotPlan(withdrawn(), reopened({ records: [childQueue(0, "rq-9")] }));
  expect(otherLane).toMatchObject({ resends: 1 });
});

test("an id the runtime already saw needs a fresh one, and an unobserved outcome needs the host's consent", () => {
  // A native queue the runtime took and then gave back on withdraw: ownership is the caller's, the id is not fresh.
  const seen = snapshotOf([queue(0, "rq-1"), accepted(1, "rq-1"), withdraw(2, "rq-2"), accepted(3, "rq-2")]);
  expect(queueSnapshotPlan(seen, reopened())).toMatchObject({ resends: 0, entries: [{ resend: false, code: "input_id_reused" }] });
  expect(queueSnapshotPlan(seen, reopened(), { inputId: () => OTHER_INPUT })).toMatchObject({ resends: 1, entries: [{ resend: true, inputId: OTHER_INPUT }] });
  const unanswered = snapshotOf([queue(0, "rq-1")]);
  expect(queueSnapshotPlan(unanswered, reopened())).toMatchObject({ resends: 0, entries: [{ resend: false, code: "unconfirmed" }] });
  expect(queueSnapshotPlan(unanswered, reopened(), { allowUncertain: () => true, inputId: () => OTHER_INPUT })).toMatchObject({ resends: 1 });
  // A later refusal does not undo an earlier acceptance: that input is still held, so it is not a resend candidate at all.
  const stillHeld = snapshotOf([queue(0, "rq-1"), accepted(1, "rq-1"), queue(2, "rq-2"), rejected(3, "rq-2")]);
  expect(queueSnapshotPlan(stillHeld, reopened())).toMatchObject({ resends: 0, entries: [{ resend: false, code: "held_by_runtime" }] });
});

test("plan order follows the snapshot, and a plan alone sends nothing", () => {
  const plan = queueSnapshotPlan(snapshotOf([queue(0, "rq-1"), rejected(1, "rq-1"), queue(2, "rq-2", { inputId: SECOND_INPUT, input: "second" }), rejected(3, "rq-2")]), reopened());
  expect(plan.entries.map((planned) => planned.entry.input)).toEqual(["later", "second"]);
  expect(plan.resends).toBe(2);
});

test("restore queues only returned inputs, in order, with their images and origin, and reports the rest", async () => {
  const first = queue(0, "rq-1", { input: "first", images: [{ path: "/tmp/a.png" }], origin: { kind: "notification", source: "job" } });
  const records = [
    first, rejected(1, "rq-1"),
    queue(2, "rq-2", { inputId: SECOND_INPUT }), accepted(3, "rq-2", "adapter"),
    prompt(4, "rq-3", { inputId: THIRD_INPUT }), rejected(5, "rq-3", "busy"),
  ];
  const { session, calls } = recorder();
  const result = await restoreQueue(session, snapshotOf(records), { streamId: "stream-2" });
  expect(calls).toEqual([{ input: "first", options: { inputId: SNAPSHOT_INPUT, images: [{ path: "/tmp/a.png" }], origin: { kind: "notification", source: "job" } } }]);
  expect(result.resent.map((resent) => [resent.inputId, resent.outcome.kind])).toEqual([[SNAPSHOT_INPUT, "accepted"]]);
  expect(result.skipped.map((planned) => planned.code)).toEqual(["held_by_oar", "not_a_queue_input"]);
});

test("a blocked or current plan sends nothing and still reports every decision", async () => {
  const snapshot = snapshotOf([queue(0, "rq-1"), rejected(1, "rq-1")]);
  const { session, calls } = recorder();
  const stranger: QueueRestoreSession = { id: "another-session", queue: session.queue };
  const foreign = await restoreQueue(stranger, snapshot, { streamId: "stream-2" });
  expect(foreign.plan.status).toBe("blocked");
  expect(calls).toEqual([]);
  const current = await restoreQueue(session, snapshot, { streamId: STREAM, prior: [rejected(1, "rq-1")] });
  expect(current.plan.status).toBe("current");
  expect(calls).toEqual([]);
});

test("a refused resend carries its code and does not stop the rest", async () => {
  const records = [queue(0, "rq-1"), rejected(1, "rq-1"), queue(2, "rq-2", { inputId: SECOND_INPUT, input: "second" }), rejected(3, "rq-2")];
  const session: QueueRestoreSession = {
    id: SESSION,
    queue: async (input, options) => (input === "later"
      ? { kind: "rejected", seq: 4, requestId: "rq-x", code: "runtime_exited", reason: "gone", request: queue(4, "rq-x", { ...options, input }), response: rejected(5, "rq-x") }
      : acceptedOutcome(6, "rq-y")),
  };
  const result = await restoreQueue(session, snapshotOf(records), { streamId: "stream-2" });
  expect(result.resent.map((resent) => resent.outcome.kind)).toEqual(["rejected", "accepted"]);
  expect(result.resent[0]?.outcome).toMatchObject({ code: "runtime_exited" });
});

test("a queue the runtime accepted is never resent into the reopened session", async () => {
  const { session, calls } = recorder();
  const result = await restoreQueue(session, snapshotOf([queue(0, "rq-1"), accepted(1, "rq-1")]), { streamId: "stream-2" });
  expect(calls).toEqual([]);
  expect(result.plan.entries).toMatchObject([{ resend: false, code: "held_by_runtime" }]);
});

test("a withdrawn input is restored exactly once through the ordinary queue call", async () => {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: "/tmp" });
  try {
    const running = await session.prompt("hang");
    expect(running.kind).toBe("accepted");
    const held = await session.queue("restore me");
    const heldId = held.request.body.kind === "queue" ? held.request.body.inputId : undefined;
    expect(heldId).toBeDefined();
    if (heldId === undefined) { return; }
    const taken = await session.withdraw?.(heldId);
    expect(taken?.kind).toBe("accepted");
    const snapshot = queueSnapshotOf(session.records(), { streamId: STREAM, sessionId: session.id });
    expect(snapshot.entries.find((entry) => entry.inputId === heldId)?.evidence).toMatchObject({ ownership: "caller", resend: "safe", code: "withdrawn" });
    // This fixture's queue acceptance names no adapter hold, so the id counts as one the runtime may have seen.
    const reused = await restoreQueue(session, snapshot, { streamId: "stream-2" });
    expect(reused.skipped.map((planned) => planned.code)).toEqual(["delivered", "input_id_reused"]);
    const result = await restoreQueue(session, snapshot, { streamId: "stream-2", inputId: () => SECOND_INPUT });
    expect(result.resent.map((resent) => [resent.inputId, resent.outcome.kind])).toEqual([[SECOND_INPUT, "accepted"]]);
    expect(session.records().filter((record) => record.kind === "request" && record.body.kind === "queue")).toHaveLength(2);
    const aborted = await session.abort();
    expect(aborted.kind).toBe("accepted");
  } finally {
    await session.dispose();
  }
});

test("a queue the live session still holds is not resent by a snapshot of it", async () => {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: "/tmp" });
  try {
    const running = await session.prompt("hang");
    expect(running.kind).toBe("accepted");
    const held = await session.queue("still held");
    expect(held.kind).toBe("accepted");
    const snapshot = queueSnapshotOf(session.records(), { streamId: STREAM, sessionId: session.id });
    const requests = (): number => session.records().filter((record) => record.kind === "request" && record.body.kind === "queue").length;
    const result = await restoreQueue(session, snapshot, { streamId: "stream-2" });
    expect(result.resent).toEqual([]);
    expect(requests()).toBe(1);
    await session.abort();
  } finally {
    await session.dispose();
  }
});
