import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { batchProcessTableReads } from "../packages/oar/src/shared/executable/process-table-async.js";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";

const first: ProcessTableObservation = { ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map() };
const second: ProcessTableObservation = { ...first, elapsedMs: 2 };
afterEach(() => { vi.restoreAllMocks(); });

// oxlint-disable-next-line eslint/max-statements -- The arrivals straddle a query start and must see different generations.
test("simultaneous callers share a query; requests during that query wait for a new one", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockImplementationOnce(async () => gate.promise).mockResolvedValue(second);
  const read = batchProcessTableReads(query);
  const a = read("windows"), b = read("windows");
  expect(query).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(query).toHaveBeenCalledOnce();
  const late = read("windows");
  await nextTurn();
  expect(query).toHaveBeenCalledOnce();
  gate.resolve(first);
  expect(await a).toBe(first);
  expect(await b).toBe(first);
  expect(await late).toBe(second);
  expect(query).toHaveBeenCalledTimes(2);
  await read("windows");
  expect(query).toHaveBeenCalledTimes(3);
});

// oxlint-disable-next-line eslint/max-statements -- Failed batch and recovery are one causal sequence.
test("a rejected query resolves each caller with redacted failure and does not poison the next batch", async () => {
  const rejected: unknown[] = [];
  const onRejected = (error: unknown): void => { rejected.push(error); };
  process.on("unhandledRejection", onRejected);
  try {
    const query = vi.fn().mockRejectedValueOnce(Object.assign(new Error("private query command"), { code: "ETIMEDOUT", stderr: "private" })).mockResolvedValue(first);
    const read = batchProcessTableReads(query);
    const [a, b] = await Promise.all([read("windows"), read("windows")]);
    expect(a).toBe(b);
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric numeric matcher.
    expect(a).toEqual({ ok: false, source: "windows", elapsedMs: expect.any(Number), reason: "timeout", code: "ETIMEDOUT", timeoutMs: 5000 });
    expect(await read("windows")).toBe(first);
    await nextTurn();
    expect(rejected).toEqual([]);
  } finally { process.off("unhandledRejection", onRejected); }
});

test.each([true, false])("a foreground caller keeps its shared batch alive (preparation first: %s)", async (backgroundFirst) => {
  const query = vi.fn().mockResolvedValue(first);
  const read = batchProcessTableReads(query);
  const a = read("windows", backgroundFirst ? { background: true } : undefined);
  const b = read("windows", backgroundFirst ? undefined : { background: true });
  await Promise.all([a, b]);
  expect(query).toHaveBeenCalledExactlyOnceWith("windows", undefined);
});

// oxlint-disable-next-line eslint/max-statements -- The foreground request must arrive after the preparation's physical query starts.
test("preparation alone is background; a later foreground request gets a fresh foreground query", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(second);
  const read = batchProcessTableReads(query);
  const preparation = read("windows", { background: true });
  await nextTurn();
  expect(query).toHaveBeenCalledExactlyOnceWith("windows", { background: true });
  const cleanup = read("windows");
  await nextTurn(); expect(query).toHaveBeenCalledTimes(1);
  gate.resolve(first); await Promise.all([preparation, cleanup]);
  expect(query).toHaveBeenNthCalledWith(2, "windows", undefined);
});
