import { expect, test } from "vitest";
import type { Frame, RawEvent, RuntimeEventBody } from "../packages/oar/src/contracts/records.js";
import { eventsOf, statusOf, usageOf, viewOf } from "../packages/oar/src/observe/index.js";
import { checkRetainedBytes } from "../packages/oar/src/shared/record-retention.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";

const big = "x".repeat(1000);
const toolEvents: readonly RuntimeEventBody[] = [
  { kind: "tool_call_started", callId: "c", tool: "shell", input: big },
  { kind: "tool_call_ended", callId: "c", result: "ok", exitCode: 0, content: [{ type: "text", text: big }] },
];

function run(retainedBytes: number | undefined, count: number): { kernel: SessionKernel; live: RawEvent[] } {
  const kernel = createSessionKernel("s", undefined, retainedBytes);
  const live: RawEvent[] = [];
  kernel.rawEvents((record) => { live.push(record); });
  for (let index = 0; index < count; index += 1) { kernel.frame({ type: "item", native: { big }, events: toolEvents }); }
  return { kernel, live };
}

function frames(records: readonly RawEvent[]): Frame[] {
  return records.filter((record): record is Frame => record.kind === "frame");
}

test("without a limit nothing is elided", () => {
  expect(frames(run(undefined, 10).kernel.records()).some((frame) => frame.body.elided === true)).toBe(false);
});

test("the oldest frames lose native and tool payloads; records, seq and the rest stay", () => {
  const stored = frames(run(10_000, 10).kernel.records());
  expect(stored.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(stored.at(0)?.body).toEqual({
    type: "item", native: null, elided: true,
    events: [{ kind: "tool_call_started", callId: "c", tool: "shell" }, { kind: "tool_call_ended", callId: "c", result: "ok", exitCode: 0 }],
  });
  expect(stored.at(-1)?.body).toEqual({ type: "item", native: { big }, events: toolEvents });
  expect(JSON.stringify(stored).length).toBeLessThan(15_000);
});

test("live observers receive every record complete", () => {
  const { live } = run(1000, 10);
  expect(frames(live).every((frame) => frame.body.elided === undefined && frame.body.native !== null)).toBe(true);
  expect(live).toHaveLength(10);
});

test("a frame an observer appends while one is being published is still delivered complete", () => {
  const kernel = createSessionKernel("s", undefined, 1);
  const live: RawEvent[] = [];
  kernel.rawEvents((record) => {
    live.push(record);
    if (record.seq === 0) { kernel.frame({ type: "nested", native: { big }, events: [] }); }
  });
  kernel.frame({ type: "first", native: { big }, events: [] });
  expect(frames(live).map((frame) => [frame.body.type, frame.body.elided])).toEqual([["first", undefined], ["nested", undefined]]);
});

test("cursor replay and events say what was elided", () => {
  const { kernel } = run(10_000, 10);
  const replayed: RawEvent[] = [];
  kernel.rawEvents((record) => { replayed.push(record); }, { sessionId: "s", afterSeq: -1 });
  expect(frames(replayed).at(0)?.body.elided).toBe(true);
  const events = kernel.records().flatMap((record) => eventsOf(record));
  expect(events.at(0)).toMatchObject({ kind: "tool_call_started", elided: true });
  expect(events.at(-1)).not.toHaveProperty("elided");
});

test("status and usage read the same with and without a limit", () => {
  const read = (limit: number | undefined): unknown => {
    const kernel = createSessionKernel("s", undefined, limit);
    kernel.frame({ type: "start", native: { big }, events: [{ kind: "turn_active" }] }, { receivedAt: 1 });
    kernel.frame({ type: "used", native: { big }, events: [{ kind: "usage", usage: { total: { input: 3, output: 2 } } }] }, { receivedAt: 2 });
    kernel.frame({ type: "more", native: { big }, events: [] }, { receivedAt: 3 });
    return { status: statusOf(kernel.records(), "s").value, usage: usageOf(kernel.records(), "s", kernel.graph()).value };
  };
  expect(read(1)).toEqual(read(undefined));
});

test("output deltas are elided and the budget counts what remains", () => {
  const kernel = createSessionKernel("s", undefined, 1000);
  for (let index = 0; index < 20; index += 1) {
    kernel.frame({ type: "item/commandExecution/outputDelta", native: { delta: "y".repeat(10_000) }, events: [{ kind: "tool_call_progress", callId: "c", outputDelta: "y".repeat(10_000) }] });
  }
  expect(JSON.stringify(kernel.records()).length).toBeLessThan(40_000);
});

test("the limit counts UTF-8 bytes, not characters", () => {
  const kernel = createSessionKernel("s", undefined, 1000);
  kernel.frame({ type: "a", native: "\u4E2D".repeat(300), events: [] });
  kernel.frame({ type: "b", native: "\u4E2D".repeat(300), events: [] });
  expect(frames(kernel.records()).map((frame) => frame.body.elided)).toEqual([true, undefined]);
});

test("a session view marks the tool whose input or output was elided", () => {
  const { kernel } = run(10_000, 10);
  const tool = (seq: number): unknown => viewOf(kernel.records().filter((record) => record.seq === seq)).messages.flatMap((message) => message.kind === "turn" ? message.sections.flatMap((section) => section.parts) : []).find((part) => part.kind === "tool");
  expect(tool(0)).toMatchObject({ callId: "c", elided: true, result: "ok" });
  expect(tool(9)).not.toHaveProperty("elided");
});

test.each([0, -1, 1.5, Number.NaN])("retainedBytes %s is refused", (value) => {
  expect(() => { checkRetainedBytes(value); }).toThrow("retainedBytes");
});
