/* oxlint-disable eslint/max-statements -- Keep each ordered native control and its negative assertions together. */
import { afterEach, expect, test, vi } from "vitest";
import type { FrameBody, RuntimeEventBody } from "../packages/oar/src/contracts/session.js";
import { statusOf, initialStatus, reduceStatus } from "../packages/oar/src/observe/agent-status.js";
import { manualCompaction } from "../packages/oar/src/shared/manual-compaction.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { piCompaction } from "../packages/oar/src/runtimes/pi/compaction.js";
import { piRpcControl } from "../packages/oar/src/runtimes/pi/rpc/control.js";
import { fakeLineProcess } from "./fixtures/fake-line-process.js";

afterEach(() => { vi.useRealTimers(); });
const start: RuntimeEventBody = { kind: "compaction_started", trigger: "manual" };
const end: RuntimeEventBody = { kind: "compaction_ended", trigger: "manual", outcome: "completed" };
const body = (...events: RuntimeEventBody[]): FrameBody => ({ type: "native-test", native: { events }, events });


function setup(run: () => Promise<unknown> = async () => {}) {
  const kernel = createSessionKernel("root");
  const compaction = manualCompaction(kernel, { busy: () => false, busyReason: "busy", create: () => piCompaction(kernel, run) });
  return { kernel, ...compaction };
}

test.each(["timeout", "signal"] as const)("%s changes only the wait; children, automatic ends and repeated calls cannot free the slot", async (mode) => {
  const f = setup();
  const signal = new AbortController();
  const waiting = f.compact(mode === "timeout" ? { timeoutMs: 1 } : { signal: signal.signal });
  f.kernel.frame(body(start));
  const records = f.kernel.records().length;
  if (mode === "signal") { signal.abort(); }
  expect(await waiting).toMatchObject({ kind: "unconfirmed", code: mode });
  expect(f.kernel.records()).toHaveLength(records);
  expect(statusOf(f.kernel.records()).value).toMatchObject({ kind: "running", phase: "compacting" });
  expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
  f.kernel.frame(body(end), { agentPath: ["child"] });
  f.kernel.frame(body(end), { sessionId: "foreign" });
  f.kernel.frame(body({ kind: "compaction_ended", trigger: "threshold", outcome: "completed" }));
  expect(f.busy()).toBe(true);
  expect(statusOf(f.kernel.records(), "root").value).toMatchObject({ kind: "running", phase: "compacting" });
  f.kernel.frame(body(end));
  expect(f.busy()).toBe(false);
  expect(statusOf(f.kernel.records(), "root").value.kind).toBe("idle");
});

test.each(["failed", "aborted"] as const)("native %s is retained as its own outcome and releases the slot", async (outcome) => {
  const f = setup();
  const waiting = f.compact();
  f.kernel.frame(body(start));
  const frame = f.kernel.frame(body({ kind: "compaction_ended", trigger: "manual", outcome, reason: "native detail" }));
  expect(await waiting).toMatchObject({ kind: outcome, frame });
  expect(f.busy()).toBe(false);
  expect(statusOf(f.kernel.records()).value.kind).toBe("idle");
});

test("an SDK rejection after admission supplies native failure evidence", async () => {
  const gate = Promise.withResolvers<void>();
  const f = setup(async () => gate.promise);
  const waiting = f.compact();
  f.kernel.frame(body(start));
  gate.reject(new Error("native compactor failed"));
  expect(await waiting).toMatchObject({ kind: "failed", code: "native_failed", frame: { body: { native: { message: "native compactor failed" } } } });
  expect(statusOf(f.kernel.records()).value.kind).toBe("idle");
});

test.each(["exit", "dispose"] as const)("%s ends observation without manufacturing a compaction result", async (mode) => {
  const f = setup();
  const waiting = f.compact();
  f.kernel.frame(body(start));
  if (mode === "exit") { f.kernel.respond("", { kind: "exited", code: 1 }); }
  else { f.kernel.request("toRuntime", { kind: "dispose" }); }
  expect(await waiting).toMatchObject({ kind: "unconfirmed", code: mode === "exit" ? "runtime_exited" : "disposed" });
  expect(f.busy()).toBe(false);
  expect(f.kernel.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "compaction_ended"))).toBe(false);
});

test("a synchronous observer cannot acquire the same compaction slot twice", async () => {
  const f = setup();
  const second: { value?: ReturnType<typeof f.compact> } = {};
  let entered = false;
  f.kernel.rawEvents((record) => { if (!entered && record.kind === "request" && record.body.kind === "compact") { entered = true; second.value = f.compact(); } });
  const first = f.compact();
  expect(await second.value).toMatchObject({ kind: "rejected", code: "busy" });
  f.kernel.frame(body(start)); f.kernel.frame(body(end));
  expect(await first).toMatchObject({ kind: "completed" });
});

test("status checkpoints retain the compaction identity across native queued receipts and unrelated ends", async () => {
  const f = setup();
  const waiting = f.compact();
  const request = f.kernel.records().find((record) => record.kind === "request");
  expect(request?.kind).toBe("request");
  if (request?.kind !== "request") { throw new Error("missing request"); }
  f.kernel.frame(body({ kind: "input_queued", inputId: request.id }));
  f.kernel.frame(body({ kind: "turn_active", inputId: request.id }));
  f.kernel.frame(body(start));
  f.kernel.frame(body({ kind: "turn_ended", inputId: "old", outcome: { kind: "completed" } }));
  expect(statusOf(f.kernel.records()).value).toMatchObject({ kind: "running", phase: "compacting" });
  f.kernel.frame(body(end));
  f.kernel.frame(body({ kind: "turn_ended", inputId: request.id, outcome: { kind: "completed" } }));
  expect(await waiting).toMatchObject({ kind: "completed" });
  const records = f.kernel.records();
  for (let split = 0; split < records.length; split += 1) {
    const checkpoint = records.slice(0, split).reduce((state, record) => reduceStatus(state, record, "root"), initialStatus);
    expect(records.slice(split).reduce((state, record) => reduceStatus(state, record, "root"), checkpoint)).toEqual(statusOf(records, "root").value);
  }
  expect(statusOf(records).value.kind).toBe("idle");
});

test("Pi RPC's ordinary 30 second transport deadline cannot kill a compact operation", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess();
  const rpc = piRpcControl(child, () => {});
  const pending = rpc.request({ type: "compact" });
  await vi.advanceTimersByTimeAsync(31_000);
  expect(child.killed()).toBe(false);
  child.emit(`${JSON.stringify({ type: "response", id: "oar-pi-0", command: "compact", success: true, data: {} })}\n`);
  expect(await pending).toMatchObject({ success: true });
});
