/* oxlint-disable eslint/max-statements -- Exercise queue ownership across cancellation and handoff in one test. */
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireOpenCodeStartup } from "../../packages/oar/src/runtimes/opencode/startup-gate.js";

afterEach(() => { vi.useRealTimers(); });
const options = (name: string) => ({ cwd: process.cwd(), env: { XDG_DATA_HOME: join(tmpdir(), `oar-gate-${name}`) } });

test("a cancelled waiter neither releases its owner nor blocks the next waiter", async () => {
  const config = options("abort");
  const owner = await acquireOpenCodeStartup(config);
  const abort = new AbortController();
  const cancelled = acquireOpenCodeStartup(config, 60_000, abort.signal);
  const rejection = expect(cancelled).rejects.toThrow("cancelled");
  let acquired = false;
  const next = (async () => { const release = await acquireOpenCodeStartup(config); acquired = true; return release; })();
  abort.abort(new Error("cancelled")); await rejection;
  expect(acquired).toBe(false);
  owner(); const release = await next;
  owner(); // A stale owner's second release must not unlock the new owner.
  const blocked = acquireOpenCodeStartup(config, 1);
  await expect(blocked).rejects.toMatchObject({ kind: "timeout", method: "startup queue" });
  release(); (await acquireOpenCodeStartup(config))();
});

test("a pre-aborted waiter never takes a free lock", async () => {
  const signal = AbortSignal.abort(new Error("already cancelled"));
  await expect(acquireOpenCodeStartup(options("preabort"), 60_000, signal)).rejects.toThrow("already cancelled");
  (await acquireOpenCodeStartup(options("preabort")))();
});

test("queue wait has a finite bound and does not release the owner on timeout", async () => {
  vi.useFakeTimers();
  const config = options("timeout"); const owner = await acquireOpenCodeStartup(config);
  const expired = expect(acquireOpenCodeStartup(config, 50)).rejects.toMatchObject({ kind: "timeout", timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(50); await expired;
  const again = expect(acquireOpenCodeStartup(config, 50)).rejects.toMatchObject({ kind: "timeout" });
  await vi.advanceTimersByTimeAsync(50); await again;
  owner(); (await acquireOpenCodeStartup(config))(); expect(vi.getTimerCount()).toBe(0);
});

test("symlink aliases of a not-yet-created data directory share one gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "oar-gate-path-"));
  try {
    await mkdir(join(root, "real")); await symlink(join(root, "real"), join(root, "alias"), "junction");
    const owner = await acquireOpenCodeStartup({ cwd: root, env: { XDG_DATA_HOME: join(root, "real", "new") } });
    try {
      await expect(acquireOpenCodeStartup({ cwd: root, env: { XDG_DATA_HOME: join(root, "alias", "new") } }, 1)).rejects.toMatchObject({ kind: "timeout" });
      (await acquireOpenCodeStartup({ cwd: root, env: { XDG_DATA_HOME: join(root, "other") } }))();
    } finally { owner(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
