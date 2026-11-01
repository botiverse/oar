import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";
import type { observeProcessTableOnce } from "../packages/oar/src/shared/executable/process-table-async.js";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const first: ProcessTableObservation = { ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map() };
const second: ProcessTableObservation = { ...first, elapsedMs: 2 };

async function reader(query: typeof observeProcessTableOnce) {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  const batch = tables.batchProcessTableReads(query);
  vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async (source, options) => batch(source ?? "windows", options));
  const { observeProcessTableWithin } = await import("../packages/oar/src/shared/executable/process-table-budget.js");
  return { raw: tables.observeProcessTableAsync, within: observeProcessTableWithin };
}

// oxlint-disable-next-line eslint/max-statements -- Expire the sole queued caller, finish its predecessor, then prove a subsequent fresh read still works.
test("a queued read whose only caller expired never starts", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const background = read.raw("windows", { background: true });
  await vi.advanceTimersByTimeAsync(0);
  const expired = read.within(1000, "windows");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await expired).toMatchInlineSnapshot(`
    {
      "elapsedMs": 1000,
      "ok": false,
      "reason": "timeout",
      "source": "windows",
      "timeoutMs": 1000,
    }
  `);
  expect(query).toHaveBeenCalledOnce();
  gate.resolve(first); await background;
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledOnce();
  expect(await read.within(1000, "windows")).toBe(second);
  expect(query).toHaveBeenCalledTimes(2);
});

// oxlint-disable-next-line eslint/max-statements -- The expired and live callers share one pending generation but retain separate deadlines.
test.each([false, true])("an expired caller cannot cancel a live caller's queued read (new caller after expiry: %s)", async afterExpiry => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const expired = read.within(1000, "windows");
  if (afterExpiry) { await vi.advanceTimersByTimeAsync(1000); }
  const live = read.within(5000, "windows");
  if (!afterExpiry) { await vi.advanceTimersByTimeAsync(1000); }
  expect(await expired).toMatchObject({ ok: false });
  expect(query).toHaveBeenCalledOnce();
  gate.resolve(first); await previous;
  expect(await live).toBe(second);
  expect(query).toHaveBeenCalledTimes(2);
  expect(await expired).toMatchObject({ ok: false });
});

// oxlint-disable-next-line eslint/max-statements -- Handle ownership is chosen from live callers at the actual query start.
test.each([false, true])("only live callers decide whether a pending query is background (live background: %s)", async background => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const expired = read.within(1000, "windows", { background: !background });
  const live = read.within(5000, "windows", { background });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await expired).toMatchObject({ ok: false });
  gate.resolve(first); await previous; await live;
  expect(query).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenNthCalledWith(2, "windows", background ? { background: true } : undefined);
});

// oxlint-disable-next-line eslint/max-statements -- An expired owner never interrupts its running query or lends its old result to a later request.
test("a started query finishes after its caller expires; a later caller waits for a fresh one", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const expired = read.within(1000, "windows");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await expired).toMatchObject({ ok: false });
  const next = read.within(5000, "windows");
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledOnce();
  gate.resolve(first);
  expect(await next).toBe(second);
  expect(query).toHaveBeenCalledTimes(2);
  expect(await expired).toMatchObject({ ok: false });
});

// oxlint-disable-next-line eslint/max-statements -- A delayed timer must not allow an already overdue query to start or supply evidence.
test("deadline checks do not depend on the timeout callback running", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const expired = read.within(1000, "windows");
  vi.spyOn(performance, "now").mockReturnValue(1000);
  gate.resolve(first); await previous;
  expect(await expired).toMatchObject({ ok: false, reason: "timeout", elapsedMs: 1000, timeoutMs: 1000 });
  expect(query).toHaveBeenCalledOnce();
});

test("a running query returned before an overdue timer still cannot provide late identity evidence", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValue(gate.promise);
  const read = await reader(query);
  const expired = read.within(1000, "windows");
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledOnce();
  vi.spyOn(performance, "now").mockReturnValue(1000);
  gate.resolve(first);
  expect(await expired).toMatchObject({ ok: false, reason: "timeout", elapsedMs: 1000, timeoutMs: 1000 });
});

test("a wall-clock change does not expire a live caller", async () => {
  const query = vi.fn().mockResolvedValue(first);
  const read = await reader(query);
  const live = read.within(1000, "windows");
  vi.setSystemTime(Date.now() + 86_400_000);
  expect(await live).toBe(first);
  expect(query).toHaveBeenCalledOnce();
});

// oxlint-disable-next-line eslint/max-statements -- Expiry must consider every caller, including one without a finite budget.
test.each([false, true])("multiple expired callers leave no read unless an unbounded caller joined: %s", async unbounded => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const short = read.within(500, "windows");
  const long = read.within(1000, "windows");
  const live = unbounded ? read.raw("windows") : undefined;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await short).toMatchObject({ ok: false }); expect(await long).toMatchObject({ ok: false });
  gate.resolve(first); await previous; await live;
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(unbounded ? 2 : 1);
  if (unbounded) { expect(await live).toBe(second); }
});

// oxlint-disable-next-line eslint/max-statements -- An unbounded background caller remains live even if it waits beyond the usual preparation budget.
test.each([false, true])("a queued background request without a deadline still runs (expired foreground joined: %s)", async foreground => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const background = read.raw("windows", { background: true });
  const expired = foreground ? read.within(1000, "windows") : undefined;
  await vi.advanceTimersByTimeAsync(10_000);
  if (foreground) { expect(await expired).toMatchObject({ ok: false }); }
  expect(query).toHaveBeenCalledOnce();
  gate.resolve(first); await previous;
  expect(await background).toBe(second);
  expect(query).toHaveBeenNthCalledWith(2, "windows", { background: true });
});

// oxlint-disable-next-line eslint/max-statements -- A caller arriving at skipped-batch settlement must obtain its own later snapshot.
test("a new caller at skipped-batch settlement does not receive the skipped result", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const skipped = read.raw("windows", { deadline: 1000 });
  const next = (async () => {
    expect(await skipped).toMatchObject({ ok: false, reason: "timeout" });
    return read.raw("windows");
  })();
  await vi.advanceTimersByTimeAsync(1000);
  gate.resolve(first); await previous;
  expect(await next).toBe(second);
  expect(query).toHaveBeenCalledTimes(2);
});

// oxlint-disable-next-line eslint/max-statements -- Product preparation keeps its existing five-second budget, distinct from unbounded background requests.
test("product preparation that expires before its query starts remains failed and skips the query", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = await reader(query);
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  vi.spyOn(tables, "processTableSource").mockReturnValue("windows");
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const preparation = await import("../packages/oar/src/shared/executable/process-table-preparation.js");
  preparation.prepareProcessTable();
  await vi.advanceTimersByTimeAsync(5000);
  const result = preparation.processTablePreparation();
  expect(result).toMatchObject({ ok: false, reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 });
  gate.resolve(first); await previous;
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledOnce();
  expect(preparation.processTablePreparation()).toEqual(result);
});

// oxlint-disable-next-line eslint/max-statements -- Failure, expired/live queued callers and a later fresh query form one causal sequence.
test.each([false, true])("a failed predecessor still serves only live queued callers (throws: %s)", async throws => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const third = { ...first, elapsedMs: 3 };
  const failure: ProcessTableObservation = { ok: false, source: "windows", elapsedMs: 1000, reason: "read_failed", code: "EIO" };
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce(second).mockResolvedValue(third);
  const read = await reader(query);
  const previous = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const expired = read.within(1000, "windows");
  const live = read.within(5000, "windows", { background: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await expired).toMatchObject({ ok: false, reason: "timeout" });
  expect(query).toHaveBeenCalledOnce();
  if (throws) { gate.reject(Object.assign(new Error("private read failure"), { code: "EIO" })); }
  else { gate.resolve(failure); }
  expect(await previous).toEqual(failure);
  expect(await live).toBe(second);
  expect(query).toHaveBeenNthCalledWith(2, "windows", { background: true });
  expect(await read.within(1000, "windows")).toBe(third);
  expect(query).toHaveBeenCalledTimes(3);
  expect(await expired).toMatchObject({ ok: false, reason: "timeout" });
});

// oxlint-disable-next-line eslint/max-statements -- One source must advance independently while another has a running query and an expired queued caller.
test("a blocked source and its expired batch do not block or reuse another source's queries", async () => {
  const windowsGate = Promise.withResolvers<ProcessTableObservation>();
  const psGate = Promise.withResolvers<ProcessTableObservation>();
  const psFirst: ProcessTableObservation = { ...first, source: "ps" };
  const psSecond: ProcessTableObservation = { ...second, source: "ps" };
  const query = vi.fn().mockReturnValueOnce(windowsGate.promise).mockReturnValueOnce(psGate.promise).mockResolvedValueOnce(psSecond).mockResolvedValue(second);
  const read = await reader(query);
  const windows = read.raw("windows");
  await vi.advanceTimersByTimeAsync(0);
  const expired = read.within(1000, "windows");
  const ps = read.within(5000, "ps");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await expired).toMatchObject({ ok: false, reason: "timeout" });
  expect(query).toHaveBeenNthCalledWith(2, "ps", undefined);
  psGate.resolve(psFirst);
  expect(await ps).toBe(psFirst);
  expect(await read.within(1000, "ps")).toBe(psSecond);
  expect(query).toHaveBeenNthCalledWith(3, "ps", undefined);
  windowsGate.resolve(first); await windows;
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(3);
  expect(await read.within(1000, "windows")).toBe(second);
  expect(query).toHaveBeenNthCalledWith(4, "windows", undefined);
});
