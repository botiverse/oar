/* oxlint-disable eslint/max-statements -- Each deadline scenario follows the pending operation through its late completion. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

import { createClaudeLimitResetDriver, type ClaudeLimitResetDeps, type ClaudeLimitResetDriver, type ClaudeLimitResetFlags } from "../../packages/oar/src/runtimes/claude/limit-reset/driver.js";

vi.mock("node:fs/promises", { spy: true });

const DEADLINE = { kind: "not_attempted", reason: "deadline" };
const FLAGS = { cachedGrowthBookFeatures: { tengu_cedar_ember: { enabled: true } } };
const INPUT = { command: "/synthetic/claude", kind: "weekly", idempotencyKey: "preparation" } as const;
type WorkDir = Awaited<ReturnType<NonNullable<ClaudeLimitResetDeps["workDir"]>>>;

function probe(overrides: ClaudeLimitResetDeps = {}) {
  const calls = { open: 0, directory: 0, remove: 0 };
  const driver = createClaudeLimitResetDriver({
    platform: "linux",
    cachedFlags: async () => ({ limitResets: true }),
    workDir: async () => {
      calls.directory += 1;
      return { path: "/synthetic/workdir", remove: async () => { calls.remove += 1; } };
    },
    openTerminal: () => { calls.open += 1; return null; },
    ...overrides,
  });
  return { driver, calls };
}

// oxlint-disable-next-line typescript/promise-function-async -- Preserve the driver's original promise for retry identity checks.
function call(driver: ClaudeLimitResetDriver, method: "read" | "redeem") {
  return method === "read" ? driver.read({ command: INPUT.command, atFiveHourLimit: false }) : driver.redeem(INPUT);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

for (const late of ["resolve", "reject"] as const) {
  test(`cached flags pending at the deadline: return on time, ignore late ${late}, free slot and key`, async () => {
    vi.useFakeTimers();
    const flags = Promise.withResolvers<ClaudeLimitResetFlags>();
    let waiting = true;
    const { driver, calls } = probe({ cachedFlags: async () => waiting ? flags.promise : { limitResets: true } });
    const report = driver.redeem(INPUT);
    let settled = false;
    void (async () => { await report; settled = true; })();
    await vi.advanceTimersByTimeAsync(74_999);
    assert.equal(settled, false);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(settled, true, "the caller returns without releasing the flags read");
    assert.deepEqual(await report, { result: DEADLINE, step: "flags" });
    assert.deepEqual(calls, { open: 0, directory: 0, remove: 0 });
    waiting = false;
    const retry = driver.redeem(INPUT);
    assert.notEqual(retry, report, "an unattempted key is reusable");
    await vi.advanceTimersByTimeAsync(0);
    const retried = await retry;
    assert.equal(retried.result.kind, "unsupported", "a fresh call reaches our unavailable terminal");
    if (late === "resolve") { flags.resolve({ limitResets: true }); }
    else { flags.reject(new Error("late synthetic failure")); }
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(calls, { open: 1, directory: 1, remove: 1 }, "only the retry opened a terminal");
  });
}

for (const method of ["read", "redeem"] as const) {
  for (const late of ["resolve", "reject"] as const) {
    test(`${method}: pending work directory returns at deadline, handles late ${late} without a terminal`, async () => {
      vi.useFakeTimers();
      const directory = Promise.withResolvers<WorkDir>();
      const { driver, calls } = probe({ workDir: async () => directory.promise });
      const report = call(driver, method);
      let settled = false;
      void (async () => { await report; settled = true; })();
      await vi.advanceTimersByTimeAsync(75_000);
      assert.equal(settled, true);
      assert.deepEqual(await report, { result: DEADLINE, step: "terminal" });
      assert.equal(calls.open, 0);
      if (late === "resolve") {
        directory.resolve({ path: "/synthetic/late", remove: async () => { calls.remove += 1; } });
      } else { directory.reject(new Error("late synthetic failure")); }
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(calls.open, 0);
      assert.equal(calls.remove, late === "resolve" ? 1 : 0, "the late directory is removed immediately");
    });
  }
}

test("flags and directory share the remaining budget, rather than each getting a fresh timeout", async () => {
  vi.useFakeTimers();
  const flags = Promise.withResolvers<ClaudeLimitResetFlags>();
  const directory = Promise.withResolvers<WorkDir>();
  const { driver, calls } = probe({ cachedFlags: async () => flags.promise, workDir: async () => directory.promise });
  const report = driver.redeem(INPUT);
  await vi.advanceTimersByTimeAsync(60_000);
  flags.resolve({ limitResets: true });
  await vi.advanceTimersByTimeAsync(15_000);
  assert.deepEqual(await report, { result: DEADLINE, step: "terminal" });
  directory.resolve({ path: "/synthetic/late", remove: async () => { calls.remove += 1; } });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(calls.open, 0);
  assert.equal(calls.remove, 1);
});

test("a directory arriving after the clock passes the deadline cannot beat a delayed timer", async () => {
  vi.useFakeTimers();
  const directory = Promise.withResolvers<WorkDir>();
  const { driver, calls } = probe({ workDir: async () => directory.promise });
  const report = driver.redeem(INPUT);
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 80_000);
  directory.resolve({ path: "/synthetic/late", remove: async () => { calls.remove += 1; } });
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(await report, { result: DEADLINE, step: "terminal" });
  assert.equal(calls.open, 0);
  assert.equal(calls.remove, 1);
});

for (const kind of ["regular", "directory", "missing", "fifo", "replaced-by-fifo"] as const) {
  test.skipIf(process.platform === "win32" && (kind === "fifo" || kind === "replaced-by-fifo"))(`cached flags only read regular files: ${kind}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oar-reset-flags-"));
    const config = path.join(root, ".claude.json");
    const calls = { open: 0 };
    try {
      if (kind === "regular") { await fs.writeFile(config, JSON.stringify(FLAGS)); }
      else if (kind === "directory") { await fs.mkdir(config); }
      else if (kind === "fifo" || kind === "replaced-by-fifo") {
        execFileSync("mkfifo", [config]);
        if (kind === "replaced-by-fifo") {
          const regular = path.join(root, "regular");
          await fs.writeFile(regular, "");
          const stat = await fs.lstat(regular);
          // A regular lstat observation, then open encounters a FIFO: fstat must reject it.
          vi.spyOn(fs, "lstat").mockResolvedValueOnce(stat);
        }
      }
      const driver = createClaudeLimitResetDriver({
        platform: "linux",
        workDir: async () => ({ path: root, remove: async () => {} }),
        openTerminal: () => { calls.open += 1; return null; },
      });
      const report = await driver.redeem({ ...INPUT, env: { CLAUDE_CONFIG_DIR: root } });
      assert.deepEqual(report.result, { kind: "unsupported", reason: kind === "regular" ? "unsupported_platform" : "consent_required" });
      assert.equal(calls.open, kind === "regular" ? 1 : 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
