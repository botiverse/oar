import { afterEach, beforeEach, expect, test, vi } from "vitest";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import type { observeProcessTableOnce } from "../packages/oar/src/shared/executable/process-table-async.js";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";
import type { ProcessTiming } from "../packages/oar/src/shared/executable/process-timing.js";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const result: ProcessTableObservation = { ok: true, source: "windows", elapsedMs: 1, skipped: 0,
  table: new Map([[999_999, { pid: 999_999, ppid: 888_888, pgid: 0, start: "native-identity-do-not-export" }]]) };

async function setup(query: typeof observeProcessTableOnce) {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  const batch = tables.batchProcessTableReads(query);
  vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async (source, options) => batch(source ?? "windows", options));
  const timing = await import("../packages/oar/src/shared/executable/process-timing.js");
  const events: ProcessTiming[] = [];
  const stop = timing.observeProcessTiming(event => { events.push(event); });
  const { observeProcessTableWithin: within } = await import("../packages/oar/src/shared/executable/process-table-budget.js");
  return { raw: tables.observeProcessTableAsync, within, timing, events, stop };
}

// oxlint-disable-next-line eslint/max-statements -- The caller expires while its query is still queued, then the predecessor releases it.
test("timing distinguishes an expired queued request from a query that actually started", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValue(gate.promise);
  const read = await setup(query);
  const previous = read.raw("windows", { background: true });
  await vi.advanceTimersByTimeAsync(0);
  const waiting = read.within(1000, "windows", { requestId: 700 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await waiting).toMatchObject({ ok: false, reason: "timeout", timeoutMs: 1000 });
  const joined = read.events.find(event => event.kind === "query_joined" && event.requestId === 700);
  assert.ok(joined?.kind === "query_joined");
  expect(read.events).toContainEqual({ kind: "observation_requested", requestId: 700, source: "windows", deadlineMs: 1000, atMs: 0 });
  expect(read.events).toContainEqual({ kind: "observation_returned", requestId: 700, outcome: "timeout", atMs: 1000 });
  expect(read.events.some(event => event.kind === "query_started" && event.queryId === joined.queryId)).toBe(false);
  gate.resolve(result); await previous; await vi.advanceTimersByTimeAsync(0);
  expect(read.events).toContainEqual({ kind: "query_caller_expired", queryId: joined.queryId, requestId: 700, atMs: 1000 });
  expect(read.events).toContainEqual({ kind: "query_skipped", queryId: joined.queryId, atMs: 1000 });
  expect(query).toHaveBeenCalledOnce();
  read.stop();
});

// oxlint-disable-next-line eslint/max-statements -- Preserve the failed caller even after its already-started query returns successfully.
test("timing keeps late query completion separate from the caller's timeout", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const read = await setup(vi.fn().mockReturnValue(gate.promise));
  const waiting = read.within(1000, "windows", { requestId: 701 });
  await vi.advanceTimersByTimeAsync(0);
  const started = read.events.find(event => event.kind === "query_started");
  assert.ok(started?.kind === "query_started");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await waiting).toMatchObject({ ok: false, reason: "timeout" });
  expect(read.events.some(event => event.kind === "query_finished")).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  gate.resolve(result); await vi.advanceTimersByTimeAsync(0);
  expect(read.events).toContainEqual({ kind: "observation_returned", requestId: 701, outcome: "timeout", atMs: 1000 });
  expect(read.events).toContainEqual({ kind: "query_finished", queryId: started.queryId, outcome: "ok", atMs: 1200 });
  expect(read.events.some(event => event.kind === "query_skipped")).toBe(false);
  expect(read.events.filter(event => event.kind === "observation_returned")).toHaveLength(1);
  expect(await waiting).toMatchObject({ ok: false, reason: "timeout" });
  expect(JSON.stringify(read.events)).not.toMatch(/999999|888888|native-identity|"table"|"pid"|"ppid"|"pgid"/u);
  read.stop();
});

test("a broken timing subscriber cannot turn a successful read into a failure", async () => {
  const read = await setup(vi.fn().mockResolvedValue(result));
  const stopBroken = read.timing.observeProcessTiming(() => { throw new Error("diagnostic observer failed"); });
  expect(await read.within(1000, "windows")).toBe(result);
  stopBroken(); read.stop();
  const { length } = read.events;
  expect(await read.within(1000, "windows")).toBe(result);
  expect(read.events).toHaveLength(length);
});

// oxlint-disable-next-line eslint/max-statements -- A synthetic root has no descendants or native signals; only lifecycle correlation is under test.
test("root exit, cleanup and cancellation completion retain one clock and correlation without PIDs", async () => {
  const { processShutdown } = await import("../packages/oar/src/shared/executable/process-shutdown.js");
  const cancellation = await import("../packages/oar/src/shared/executable/process-cancellation.js");
  const timing = await import("../packages/oar/src/shared/executable/process-timing.js");
  const events: ProcessTiming[] = [];
  const stop = timing.observeProcessTiming(event => { events.push(event); });
  const observe = vi.spyOn(cancellation, "observeBeforeCancellation").mockResolvedValue(result);
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 999_999 });
  const shutdown = processShutdown(child, { killTree: true });
  const stage = await shutdown.observeCancellation();
  stage.commit();
  await vi.advanceTimersByTimeAsync(10);
  shutdown.nativeExited(); await shutdown.finished;
  await vi.advanceTimersByTimeAsync(5);
  stage.complete(); stage.complete();
  expect(events.map(event => [event.kind, event.atMs])).toEqual([
    ["cancel_requested", 0], ["cancel_committed", 0], ["root_exited", 10],
    ["cleanup_started", 10], ["cleanup_finished", 10], ["cancel_completed", 15],
  ]);
  const [request] = events;
  assert.ok(request?.kind === "cancel_requested");
  expect(observe).toHaveBeenCalledExactlyOnceWith(request.requestId);
  expect(events.every(event => "shutdownId" in event && event.shutdownId === request.shutdownId)).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/999999|888888|native-identity|"table"|"pid"|"ppid"|"pgid"/u);
  stop();
});
