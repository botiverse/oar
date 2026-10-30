import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableResult } from "../packages/oar/src/shared/executable/run.js";
import { runExecutable } from "../packages/oar/src/shared/executable/index.js";
import { gone, withTreeProbe } from "./fixtures/process-tree.js";

const fixture = fileURLToPath(new URL("fixtures/probe-background-child.mjs", import.meta.url));
afterEach(() => { vi.unstubAllEnvs(); });


function expectTimeoutObservation(result: ExecutableResult | null, mode: string): void {
  const observation = result?.diagnostics?.timeoutObservation;
  if (mode === "cancelled") { expect(observation).toBeUndefined(); return; }
  // A later cleanup-induced exit must not overwrite the snapshot of a running root.
  expect(observation).toMatchObject({ closeObserved: false, exit: mode === "exited"
    ? { exitCode: 0, signal: null } : null });
  expect(Number.isFinite(Date.parse(observation?.at ?? ""))).toBe(true);
  expect(observation?.elapsedMs).toBeGreaterThan(0);
  if (mode === "exited") {
    expect(Number.isFinite(Date.parse(observation?.exit?.at ?? ""))).toBe(true);
    expect(observation?.exit?.elapsedMs).toBeLessThan(observation?.elapsedMs ?? 0);
  }
}

// The result waits for close, not exit: a descendant holding the pipes
// must still receive the timeout/cancel and the subsequent SIGKILL.
test.skipIf(process.platform === "win32").each(["exited", "running", "cancelled"])(
  "a probe with a %s leader settles and reclaims a descendant holding stdout",
  async (mode) => {
    vi.stubEnv("OAR_KILL_GRACE_MS", "100");
    // oxlint-disable-next-line max-statements -- Keep timeout evidence and descendant cleanup in the same real-process observation.
    await withTreeProbe({ ignoreSigterm: false }, async (probe) => {
      const controller = new AbortController();
      const result = runExecutable(process.execPath, [fixture], {
        env: { ...process.env, ...probe.env, OAR_FIXTURE_EARLY_EXIT: mode === "running" ? "0" : "1" },
        timeoutMs: mode === "cancelled" ? 60_000 : 2000,
        signal: controller.signal,
      });
      const tree = await probe.tree();
      if (mode !== "running") { expect(await gone(tree.agent)).toBe(true); }
      if (mode === "cancelled") { controller.abort(); }
      const bounded = await Promise.race([result, delay(5000).then(() => null)]);
      expect(bounded).toMatchObject({ ok: false, exitCode: null, diagnostics: mode === "cancelled"
        ? { error: { code: "ABORT_ERR" } } : { timeoutMs: 2000 } });
      expectTimeoutObservation(bounded, mode);
      expect(await gone(tree.grandchild)).toBe(true);
    });
  },
);
