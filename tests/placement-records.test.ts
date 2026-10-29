import { expect, test } from "vitest";
import type { RawEvent } from "../packages/oar/src/contracts/records.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { eventsOf, redactRecord } from "../packages/oar/src/observe/index.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";
import { recordLine } from "../packages/oar/src/voyage.js";

const observations = (records: readonly RawEvent[]) => {
  const { status, model, effort, serviceTier, context, usage } = viewOf(records);
  return { status, model, effort, serviceTier, context, usage };
};

test("opening and release survive voyage storage and record redaction with their attribution intact", () => {
  const kernel = createSessionKernel("resumed-session");
  kernel.opened({ requested: "auto", placement: "shared" });
  const abort = kernel.request("toRuntime", { kind: "abort" });
  kernel.respond(abort.id, { kind: "accepted" });
  kernel.respond(abort.id, { kind: "released", reason: "abort_fallback", nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true });
  kernel.respond(abort.id, { kind: "cleanup", result: { kind: "completed" } });
  const replay: RawEvent[] = kernel.records().map((record) => {
    expect(redactRecord(record)).toBe(record);
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Decode this test's own typed fixture and compare it before replay.
    const line: { kind: "record"; record: RawEvent } = JSON.parse(recordLine(record));
    return line.record;
  });
  expect(replay).toEqual(kernel.records());
  expect(replay.flatMap((record) => eventsOf(record)).map((event) => event.kind)).toEqual(["released"]);
  expect(viewOf(replay)).toEqual(viewOf(kernel.records()));
});

// oxlint-disable-next-line eslint/max-statements -- Compare the same native log with and without opening metadata, including immutability.
test("old logs without opening records keep their observations and are never backfilled", () => {
  const kernel = createSessionKernel("legacy-session");
  kernel.opened({ requested: "isolated", placement: "isolated" });
  kernel.frame({ type: "init", native: {}, events: [{ kind: "model", model: "model" }] });
  kernel.frame({ type: "result", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  const old = structuredClone(kernel.records().slice(2));
  for (const record of old) { Object.assign(record, { seq: record.seq - 2 }); }
  const before = JSON.stringify(old);
  expect(observations(old)).toEqual(observations(kernel.records()));
  expect(old.flatMap((record) => eventsOf(record)).map((event) => event.kind)).toEqual(["model", "turn_ended"]);
  expect(JSON.stringify(old)).toBe(before);
});


test("the kernel rejects opening metadata after native records without changing that log", () => {
  const kernel = createSessionKernel("late-open");
  const frame = kernel.frame({ type: "init", native: {}, events: [] });
  expect(() => { kernel.opened({ requested: "auto", placement: "isolated" }); }).toThrow("Session opening must precede all native records");
  expect(kernel.records()).toEqual([frame]);
});
