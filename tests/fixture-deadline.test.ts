import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { runExecutable, type ExecutableResult } from "../packages/oar/src/shared/executable/run.js";
import { holdFixtureDeadline } from "./fixtures/fixture-deadline.js";
import { gone, withTreeProbe } from "./fixtures/process-tree.js";

const fixture = fileURLToPath(new URL("fixtures/probe-background-child.mjs", import.meta.url));

test.each(["deadline", "abort"])("a missing readiness file joins the probe on %s before propagating ENOENT", async mode => {
  await withTreeProbe({ ignoreSigterm: false }, async probe => {
    const controller = new AbortController();
    const waitForFixture = holdFixtureDeadline();
    const settled = vi.fn((result: ExecutableResult) => result);
    const pending = runExecutable(process.execPath, [fixture], {
      env: { ...process.env, ...probe.env, OAR_FIXTURE_CLOSED_PIPES: "1" }, timeoutMs: mode === "abort" ? 60_000 : 200, signal: controller.signal,
    }).then(settled);
    await expect(waitForFixture(pending, async () => {
      await probe.tree();
      await readFile(join(probe.dir, "missing-ready"));
    }, mode === "abort" ? controller : undefined)).rejects.toMatchObject({ code: "ENOENT" });
    expect(settled.mock.calls).toMatchObject([[{ ok: false, diagnostics: mode === "abort" ? { error: { code: "ABORT_ERR" } } : { timeoutMs: 200 } }]]);
    vi.useRealTimers();
    const tree = await probe.tree();
    expect(await gone(tree.agent)).toBe(true);
    expect(await gone(tree.grandchild)).toBe(true);
  });
});
