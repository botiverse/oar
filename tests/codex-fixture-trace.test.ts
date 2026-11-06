/* oxlint-disable eslint/max-statements -- Assert trace boundaries on both sides of the controlled native warmup. */
import type fsPromises from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";

const mocks = vi.hoisted(() => {
  const cleanup: { barrier?: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void>; finished: PromiseWithResolvers<void> } } = {};
  return { warm: vi.fn<() => Promise<void>>(), record: vi.fn<(entry: Record<string, unknown>) => void>(), cleanup };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const { barrier } = mocks.cleanup;
      if (barrier !== undefined) { barrier.entered.resolve(); await barrier.release.promise; }
      try { await actual.rm(...args); } finally { barrier?.finished.resolve(); }
    },
  };
});
vi.mock("../sea-trial/harness/codex-home.js", () => ({ warmCodexHome: mocks.warm }));
vi.mock("../sea-trial/harness/trace.js", () => ({ record: mocks.record }));
beforeEach(() => { mocks.warm.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); delete mocks.cleanup.barrier; });

test("ordinary fixtures record only the two warmup boundaries with a shared home", async () => {
  const ready = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  mocks.warm.mockImplementation(async () => { entered.resolve(); await ready.promise; });
  const opening = startCodexAimock();
  await entered.promise;
  const start = mocks.record.mock.calls[0]?.[0];
  expect(start).toMatchObject({ kind: "codex_home_warmup", stage: "start" });
  expect(typeof start?.home).toBe("string");
  expect(mocks.record).toHaveBeenCalledOnce();
  ready.resolve();
  const fixture = await opening;
  try {
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record.mock.calls[1]?.[0]).toMatchObject({ kind: "codex_home_warmup", stage: "end", home: start?.home, outcome: "ready" });
    expect(typeof mocks.record.mock.calls[1]?.[0].elapsedMs).toBe("number");
  } finally { await fixture.stop(); }
});

test("a failed warmup keeps its native error and records failure, not readiness", async () => {
  const failure = new Error("native warmup refused");
  mocks.warm.mockRejectedValue(failure);
  await expect(startCodexAimock()).rejects.toBe(failure);
  expect(mocks.record).toHaveBeenCalledTimes(2);
  expect(mocks.record.mock.calls[1]?.[0]).toMatchObject({ kind: "codex_home_warmup", stage: "end", outcome: "failed" });
});

test("cold-start cases still skip warmup and both warmup records", async () => {
  const fixture = await startCodexAimock(undefined, { warmHome: false });
  try {
    expect(mocks.warm).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  } finally { await fixture.stop(); }
});

test("fixture stop returns while its private home removal is still pending", async () => {
  const fixture = await startCodexAimock();
  const barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), finished: Promise.withResolvers<void>() };
  mocks.cleanup.barrier = barrier;
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.useFakeTimers();
  const returned = vi.fn();
  const stopping = (async () => { await fixture.stop(); returned(); })();
  try {
    await barrier.entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect(returned).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "fixture_directory_cleanup", purpose: "codex-home", outcome: "pending", residue: "unconfirmed" }));
  } finally {
    barrier.release.resolve();
    await barrier.finished.promise;
    await stopping;
  }
});
