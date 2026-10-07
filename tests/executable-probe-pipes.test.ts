import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/index.js";
import { gone, withTreeProbe } from "./fixtures/process-tree.js";

const fixture = fileURLToPath(new URL("fixtures/probe-background-child.mjs", import.meta.url));
afterEach(() => { vi.unstubAllEnvs(); });

// The result waits for close, not exit: a descendant holding the pipes
// must still receive the timeout/cancel and the subsequent SIGKILL.
test.skipIf(process.platform === "win32").each(["exited", "running", "cancelled"])(
  "a probe with a %s leader settles and reclaims a descendant holding stdout",
  async (mode) => {
    vi.stubEnv("OAR_KILL_GRACE_MS", "100");
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
      expect(await gone(tree.grandchild)).toBe(true);
    });
  },
);
