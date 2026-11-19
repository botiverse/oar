import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { killGraceMs } from "../packages/oar/src/shared/executable/index.js";
import { eventually, gone, timed, withTreeProbe } from "./fixtures/process-tree.js";

import { piRpc, processSessions as runtimes } from "./fixtures/process-sessions.js";

// POSIX: that is where the runtime process leads a process group of its own.
describe.skipIf(process.platform === "win32").concurrent("dispose takes down the runtime's whole process group", () => {
  // A short grace keeps the suite fast; the default's value is not the point.
  beforeAll(() => {
    vi.stubEnv("OAR_KILL_GRACE_MS", "500");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test.each(runtimes)("%s: settles within the grace period even when the runtime ignores SIGTERM", async (_runtime, open) => {
    await withTreeProbe({ ignoreSigterm: true }, async (probe) => {
      const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
      const tree = await probe.tree();
      const elapsed = await timed(async () => session.dispose());
      assert.ok(elapsed < killGraceMs() + 2000, `dispose settled ${elapsed.toFixed(0)} ms after it was called`);
      const [request, response] = session.records().slice(-2);
      assert.ok(request?.kind === "request" && request.body.kind === "dispose" && response?.kind === "response", `the stream ends with the dispose and its answer: ${JSON.stringify(session.records().slice(-2))}`);
      assert.deepEqual({ requestId: response.requestId, body: response.body }, { requestId: request.id, body: { kind: "exited", code: null } }, "the observed (SIGKILLed) exit answers the dispose");
      assert.deepEqual([await gone(tree.agent), await gone(tree.grandchild)], [true, true], "the runtime and the tool it started are gone");
    });
  });
});

// claude's Bash tool runs each command in a session of its own, out of the
// runtime's group: dispose must reach it whether the runtime stops on SIGTERM
// (and leaves the tool behind) or only the SIGKILL ends it.
describe.skipIf(process.platform === "win32").concurrent("dispose takes down a tool that left the runtime's process group", () => {
  beforeAll(() => {
    vi.stubEnv("OAR_KILL_GRACE_MS", "500");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const cases = runtimes.flatMap(([runtime, open]) => [true, false].map((ignoreSigterm) => [runtime, ignoreSigterm, open] as const));
  test.each(cases)("%s (runtime ignores SIGTERM: %s)", async (_runtime, ignoreSigterm, open) => {
    await withTreeProbe({ ignoreSigterm, detachTool: true }, async (probe) => {
      const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
      const tree = await probe.tree();
      await session.dispose();
      assert.deepEqual([await gone(tree.agent), await gone(tree.grandchild, 1000)], [true, true], "the runtime and the tool it started are gone");
    });
  });
});

// Windows has no process groups. Each command above is a .cmd wrapper, so
// the reported agent and grandchild are both descendants of OAR's child.
test.skipIf(process.platform !== "win32").each(runtimes)(
  "%s: Windows dispose kills the runtime behind its launcher and its tool",
  async (_runtime, open) => {
    await withTreeProbe({ ignoreSigterm: true }, async (probe) => {
      const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
      const tree = await probe.tree();
      try {
        await session.dispose();
        const exit = session.records().at(-1);
        assert.ok(exit?.kind === "response" && exit.body.kind === "exited", JSON.stringify(exit));
        assert.deepEqual([await gone(tree.agent), await gone(tree.grandchild)], [true, true],
          `dispose must end native processes, not just their launcher: ${JSON.stringify(tree)}`);
      } finally {
        await session.dispose();
      }
    });
  },
);

// Windows uses taskkill directly for these non-EOF adapters; EOF failure is
// covered on all platforms in process-cleanup.test.ts.
test.skipIf(process.platform === "win32").each(runtimes)("%s records unverified descendant cleanup on dispose", async (_runtime, open) => {
  // oxlint-disable-next-line eslint/max-statements -- Failure injection, root exit, descendant liveness and cleanup are one lifecycle.
  await withTreeProbe({ ignoreSigterm: false, detachTool: true }, async (probe) => {
    const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
    const processes = await probe.tree();
    const table = await import("../packages/oar/src/shared/executable/process-table-async.js");
    const read = vi.spyOn(table, "observeProcessTableAsync").mockResolvedValue({ ok: false, source: "ps", elapsedMs: 12, reason: "command_failed", exitCode: 2 });
    try {
      await session.dispose();
      const exit = session.records().at(-1);
      assert.ok(exit?.kind === "response" && exit.body.kind === "exited");
      expect(exit.body.reason).toContain("Descendant cleanup could not be verified");
      expect(await gone(processes.agent)).toBe(true);
      expect(await gone(processes.grandchild, 50)).toBe(false);
    } finally { read.mockRestore(); await session.dispose(); }
  });
});

test.each([...runtimes, ["pi RPC", piRpc] as const])("%s answers dispose after its native process has already exited", async (_name, open) => {
  // oxlint-disable-next-line max-statements -- Keep the native exit, concurrent calls and their correlated answer in order.
  await withTreeProbe({ ignoreSigterm: false }, async probe => {
    const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
    try {
      const tree = await probe.tree();
      process.kill(tree.agent, "SIGKILL");
      expect(await eventually(() => session.records().some(record => record.kind === "response" && record.requestId === "" && record.body.kind === "exited"), 10_000)).toBe(true);
      await Promise.all([session.dispose(), session.dispose()]);
      const requests = session.records().filter(record => record.kind === "request" && record.body.kind === "dispose");
      expect(requests).toHaveLength(1);
      const [request] = requests;
      assert.ok(request?.kind === "request");
      expect(session.records().filter(record => record.kind === "response" && record.requestId === request.id)).toMatchObject([{ body: { kind: "accepted" } }]);
    } finally { await session.dispose(); }
  });
}, 20_000);
