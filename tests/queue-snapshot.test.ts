import { expect, test } from "vitest";
import type { RawEvent } from "../packages/oar/src/contracts/session.js";
import {
  QUEUE_SNAPSHOT_FORMAT,
  QUEUE_SNAPSHOT_VERSION,
  QueueSnapshotError,
  parseQueueSnapshot,
  queueSnapshotOf,
  type QueueSnapshot,
  type QueueSnapshotEntry,
} from "../packages/oar/src/observe/index.js";
import {
  SESSION,
  SNAPSHOT_INPUT,
  STREAM,
  accepted,
  childQueue,
  echo,
  exited,
  frame,
  prompt,
  queue,
  rejected,
  steer,
  withdraw,
} from "./fixtures/queue-records.js";

/**
 * The queue-snapshot projection and codec (docs/spec/queue-snapshot.md). Each
 * case is one reading of the stream: who holds the input, whether a resend is
 * safe, and what a persisted document may and may not claim.
 */

const snapshotAll = (records: readonly RawEvent[]): QueueSnapshot => queueSnapshotOf(records, { streamId: STREAM, sessionId: SESSION });

function input(records: readonly RawEvent[], id = SNAPSHOT_INPUT): QueueSnapshotEntry {
  const entry = snapshotAll(records).entries.find((candidate) => candidate.inputId === id);
  expect(entry, `an entry for ${id}`).toBeDefined();
  if (entry === undefined) { throw new Error(`no entry for ${id}`); }
  return entry;
}

function refusal(document: unknown): QueueSnapshotError {
  try {
    parseQueueSnapshot(document);
  } catch (error) {
    if (error instanceof QueueSnapshotError) { return error; }
    throw error;
  }
  throw new Error("expected a refusal");
}

function roundTrip(value: QueueSnapshot): unknown {
  // The storage path a host takes: the document as JSON text and back.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Persist and read back the public JSON document.
  return JSON.parse(JSON.stringify(value));
}

function stored(): QueueSnapshot {
  const snapshot = snapshotAll([queue(0, "rq-1"), accepted(1, "rq-1", "adapter")]);
  return parseQueueSnapshot(roundTrip(snapshot));
}

/** A queue request whose body carried no `inputId`: only older or hand-built records do this. */
function unnamedInput(seq: number, id: string, text: string): RawEvent {
  return { ...queue(seq, id), body: { kind: "queue", input: text } };
}

test("an accepted adapter queue is held by OAR and is never resent; text, images and origin are kept", () => {
  const records = [
    queue(0, "rq-1", { input: "and then this", images: [{ path: "/tmp/shot.png", mediaType: "image/png" }], origin: { kind: "automation", source: "ci" } }),
    accepted(1, "rq-1", "adapter"),
  ];
  expect(snapshotAll(records).stream).toEqual({ streamId: STREAM, sessionId: SESSION, lastSeq: 1 });
  expect(input(records)).toMatchObject({
    inputId: SNAPSHOT_INPUT,
    input: "and then this",
    images: [{ path: "/tmp/shot.png", mediaType: "image/png" }],
    origin: { kind: "automation", source: "ci" },
    agentPath: [],
    state: "accepted",
    attempts: [{ requestId: "rq-1", action: "queue", seq: 0, streamId: STREAM, state: "accepted", heldBy: "adapter" }],
    evidence: { ownership: "held_by_oar", resend: "never", code: "held_by_oar", inputIdSeenByRuntime: false },
  });
});

test("a dispatch prompt that carries the input delivers it, and the queue attempt stays beside it", () => {
  const records = [queue(0, "rq-1"), accepted(1, "rq-1", "adapter"), prompt(2, "rq-2", { carries: [SNAPSHOT_INPUT] }), accepted(3, "rq-2")];
  expect(input(records)).toMatchObject({
    state: "accepted",
    attempts: [{ action: "queue", heldBy: "adapter" }, { requestId: "rq-2", action: "prompt", state: "accepted" }],
    evidence: { ownership: "delivered", resend: "never", code: "delivered", inputIdSeenByRuntime: true },
  });
});

test("a queue the runtime accepted itself is held by the runtime, not by OAR", () => {
  expect(input([queue(0, "rq-1"), accepted(1, "rq-1")]).evidence)
    .toMatchObject({ ownership: "held_by_runtime", resend: "never", code: "held_by_runtime", inputIdSeenByRuntime: true });
});

test("a refused queue returns ownership; a refused prompt is not a queue input", () => {
  expect(input([queue(0, "rq-1"), rejected(1, "rq-1")]).evidence).toMatchObject({ ownership: "caller", resend: "safe", code: "refused", inputIdSeenByRuntime: false });
  const prompted = [prompt(0, "rq-1", { inputId: SNAPSHOT_INPUT }), rejected(1, "rq-1", "busy")];
  expect(input(prompted).evidence).toMatchObject({ ownership: "caller", resend: "never", code: "not_a_queue_input" });
});

test("an accepted withdraw returns the input and keeps the queue attempt as it was", () => {
  const records = [queue(0, "rq-1"), accepted(1, "rq-1", "adapter"), withdraw(2, "rq-2"), accepted(3, "rq-2")];
  expect(input(records)).toMatchObject({
    state: "withdrawn",
    attempts: [{ action: "queue", state: "accepted" }, { action: "withdraw", state: "accepted" }],
    evidence: { ownership: "caller", resend: "safe", code: "withdrawn", inputIdSeenByRuntime: false },
  });
});

test("a native discard returns ownership; a dropped steer is never a queue resend", () => {
  const discarded = [queue(0, "rq-1"), accepted(1, "rq-1", "adapter"), frame(2, [{ kind: "input_dropped", reason: "turn_interrupted", inputId: SNAPSHOT_INPUT }])];
  expect(input(discarded).evidence).toMatchObject({ ownership: "caller", resend: "safe", code: "discarded" });
  const steered = [steer(0, "rq-1"), accepted(1, "rq-1"), frame(2, [{ kind: "input_dropped", reason: "runtime_refused", inputId: SNAPSHOT_INPUT }])];
  expect(input(steered).evidence).toMatchObject({ ownership: "caller", resend: "never", code: "not_a_queue_input" });
});

test("an exit settles an adapter queue as lost and a runtime-held queue as unobserved", () => {
  // An earlier echo tells the fold this stream reports native echoes, so the exit settles its holds.
  const adapterHeld = [prompt(0, "rq-0"), accepted(1, "rq-0"), echo(2), queue(3, "rq-1"), accepted(4, "rq-1", "adapter"), exited(5)];
  expect(input(adapterHeld)).toMatchObject({ state: "dropped", reason: "runtime_exited", evidence: { ownership: "caller", resend: "safe", code: "adapter_queue_lost", inputIdSeenByRuntime: false } });
  const runtimeHeld = [echo(2), queue(3, "rq-1"), accepted(4, "rq-1"), exited(5)];
  expect(input(runtimeHeld)).toMatchObject({ state: "dropped", reason: "runtime_exited", evidence: { ownership: "unknown", resend: "uncertain", code: "exit_without_echo", inputIdSeenByRuntime: true } });
});

test("an exit the fold cannot settle still loses an adapter queue, while a delivered prompt stays delivered", () => {
  const records = [queue(0, "rq-1"), accepted(1, "rq-1", "adapter"), exited(2)];
  expect(snapshotAll(records).stream.ended).toEqual({ kind: "exited", seq: 2 });
  expect(input(records).evidence).toMatchObject({ ownership: "caller", resend: "safe", code: "adapter_queue_lost", inputIdSeenByRuntime: false });
  expect(input([prompt(0, "rq-1", { inputId: SNAPSHOT_INPUT }), accepted(1, "rq-1"), exited(2)]).evidence).toMatchObject({ ownership: "delivered", resend: "never", code: "delivered" });
});

test("an unanswered attempt is unobserved, never a resend anyone assumes", () => {
  expect(input([queue(0, "rq-1")]).evidence).toMatchObject({ ownership: "unknown", resend: "uncertain", code: "unobserved", inputIdSeenByRuntime: true });
  expect(input([prompt(0, "rq-1", { inputId: SNAPSHOT_INPUT })]).evidence).toMatchObject({ ownership: "unknown", resend: "never", code: "not_a_queue_input" });
});

test("input without a logical id is kept as evidence and never resent", () => {
  const [entry] = snapshotAll([unnamedInput(0, "rq-1", "unnamed"), accepted(1, "rq-1")]).entries;
  expect(entry?.inputId).toBeUndefined();
  expect(entry?.evidence).toMatchObject({ resend: "never", code: "unnamed_input" });
});

test("two inputs without a logical id stay apart: each request id is its own identity", () => {
  const document = snapshotAll([unnamedInput(0, "rq-1", "one"), accepted(1, "rq-1"), unnamedInput(2, "rq-2", "two"), accepted(3, "rq-2")]);
  expect(document.entries.map((entry) => entry.input)).toEqual(["one", "two"]);
  expect(parseQueueSnapshot(roundTrip(document))).toEqual(document);
});

test("a native echo without an observed request is left out of the snapshot", () => {
  const snapshot = snapshotAll([frame(0, [{ kind: "user_message", input: "typed", inputId: SNAPSHOT_INPUT, evidence: "conversation" }])]);
  expect(snapshot.entries).toEqual([]);
  expect(snapshot.stream.lastSeq).toBe(0);
});

test("one native session per snapshot: another session's input is not this snapshot's, while the cursor covers the stream", () => {
  const child = { ...queue(1, "rq-2"), sessionId: "child" };
  const snapshot = snapshotAll([queue(0, "rq-1"), child]);
  expect(snapshot.entries.map((entry) => entry.inputId)).toEqual([SNAPSHOT_INPUT]);
  expect(snapshot.stream.lastSeq).toBe(1);
});

test("an input is scoped to its agent lane, so equal ids in different lanes stay apart", () => {
  const snapshot = snapshotAll([queue(0, "rq-1"), childQueue(1, "rq-2")]);
  expect(snapshot.entries.map((entry) => [entry.agentPath, entry.input])).toEqual([[[], "later"], [["researcher"], "child work"]]);
});

test("a retry of one input reads the newest attempt", () => {
  const records = [queue(0, "rq-1"), rejected(1, "rq-1"), queue(2, "rq-2"), accepted(3, "rq-2", "adapter")];
  expect(input(records).attempts.map((attempt) => attempt.state)).toEqual(["rejected", "accepted"]);
  expect(input(records).evidence).toMatchObject({ ownership: "held_by_oar", resend: "never" });
});

test("a persisted snapshot survives a JSON round trip unchanged", () => {
  const document = stored();
  expect(parseQueueSnapshot(roundTrip(document))).toEqual(document);
  expect(document.format).toBe(QUEUE_SNAPSHOT_FORMAT);
  expect(document.version).toBe(QUEUE_SNAPSHOT_VERSION);
});

test("a foreign format or an unknown version is refused with its code and field", () => {
  expect(refusal({ ...stored(), format: "other/queue" })).toMatchObject({ code: "unknown_format", path: "format" });
  expect(refusal({ ...stored(), version: 2 })).toMatchObject({ code: "unsupported_version", path: "version" });
  expect(refusal(null)).toMatchObject({ code: "invalid_shape", path: "snapshot" });
});

test("a missing or ill-typed field is refused, never repaired", () => {
  const document = stored();
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ ...document, stream: { ...document.stream, streamId: "" } }, "stream.streamId"],
    [{ ...document, stream: { ...document.stream, lastSeq: -2 } }, "stream.lastSeq"],
    [{ ...document, stream: { ...document.stream, lastSeq: 1.5 } }, "stream.lastSeq"],
    [{ ...document, entries: [{ ...document.entries[0], state: "guessed" }] }, "entries[0].state"],
    [{ ...document, entries: [{ ...document.entries[0], evidence: { ...document.entries[0]?.evidence, resend: "maybe" } }] }, "entries[0].evidence.resend"],
    [{ ...document, entries: [{ ...document.entries[0], evidence: undefined }] }, "entries[0].evidence"],
    [{ ...document, entries: "none" }, "entries"],
    [{ ...document, entries: [{ ...document.entries[0], attempts: [{ ...document.entries[0]?.attempts[0], action: "abort" }] }] }, "entries[0].attempts[0].action"],
  ];
  for (const [broken, path] of cases) {
    expect(refusal(broken).path, path).toBe(path);
  }
});

test("two entries for one input in one lane are refused", () => {
  const document = stored();
  const [entry] = document.entries;
  expect(refusal({ ...document, entries: [entry, entry] })).toMatchObject({ code: "duplicate_entry", path: "entries[1].inputId" });
});

test("unknown extra fields are ignored, so a newer writer may add them", () => {
  const document = stored();
  const extended = { ...document, note: "host bookkeeping", entries: [{ ...document.entries[0], hostTag: "x" }] };
  expect(parseQueueSnapshot(extended)).toEqual(document);
});
