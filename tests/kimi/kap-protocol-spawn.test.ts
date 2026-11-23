import { afterEach, expect, test, vi } from "vitest";
import { startKimiKapProcess } from "../../packages/oar/src/runtimes/kimi/kap-protocol.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async original => ({ ...await original<object>(), spawnLineProcess: spawn }));

interface SpawnFailureOptions {
  readonly ignoreKillExit?: boolean;
  readonly exitBeforeSpawnReject?: boolean;
}

function createSpawnFailingChild(spawnError: Error, options: SpawnFailureOptions = {}): FakeLineProcess {
  const base = fakeLineProcess();
  const spawned = Promise.withResolvers<void>();
  if (options.exitBeforeSpawnReject === true) {
    queueMicrotask(() => {
      base.end(1);
      queueMicrotask(() => { spawned.reject(spawnError); });
    });
  } else {
    queueMicrotask(() => { spawned.reject(spawnError); });
  }
  return Object.assign(base, {
    spawned: spawned.promise,
    ...(options.ignoreKillExit === true ? { kill: (): void => {}, exited: Promise.resolve(null) } : {}),
  });
}

async function startAndCatch(
  spawnError: Error,
  options: SpawnFailureOptions,
): Promise<{ readonly child: FakeLineProcess; readonly caught: unknown }> {
  const child = createSpawnFailingChild(spawnError, options);
  spawn.mockReturnValueOnce(child);
  let caught: unknown = undefined;
  try {
    await startKimiKapProcess("/nonexistent", "/tmp", {}, undefined, () => {}, (text) => text, 5000);
  } catch (error: unknown) {
    caught = error;
  }
  return { child, caught };
}

async function runSpawnFailure(
  spawnError: Error,
  options: SpawnFailureOptions = {},
): Promise<{ readonly child: FakeLineProcess; readonly caught: unknown; readonly timerCountAfterReject: number; readonly unhandled: readonly unknown[] }> {
  vi.useFakeTimers();
  const unhandled: unknown[] = [];
  const onRejected = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onRejected);
  try {
    const { child, caught } = await startAndCatch(spawnError, options);
    const timerCountAfterReject = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(10_000);
    return { child, caught, timerCountAfterReject, unhandled };
  } finally {
    process.off("unhandledRejection", onRejected);
  }
}

afterEach(() => {
  spawn.mockReset();
  vi.useRealTimers();
});

test("clears timer and emits no unhandledRejection when spawn fails and kill emits exit", async () => {
  const spawnErr = Object.assign(new Error("spawn /nonexistent ENOENT"), { code: "ENOENT" });
  const result = await runSpawnFailure(spawnErr);
  expect(result.caught).toBe(spawnErr);
  expect([result.child.killed(), result.timerCountAfterReject, result.unhandled]).toEqual([true, 0, []]);
});

test("clears readiness timer when spawn fails even if onExit never fires", async () => {
  const spawnErr = Object.assign(new Error("spawn /nonexistent EACCES"), { code: "EACCES" });
  const result = await runSpawnFailure(spawnErr, { ignoreKillExit: true });
  expect(result.caught).toBe(spawnErr);
  expect([result.timerCountAfterReject, result.unhandled]).toEqual([0, []]);
});

test("emits no unhandledRejection if onExit fires before spawned rejects", async () => {
  const spawnErr = Object.assign(new Error("spawn /nonexistent ENOENT"), { code: "ENOENT" });
  const result = await runSpawnFailure(spawnErr, { exitBeforeSpawnReject: true });
  expect(result.caught).toBe(spawnErr);
  expect([result.timerCountAfterReject, result.unhandled]).toEqual([0, []]);
});
