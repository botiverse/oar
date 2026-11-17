import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Inject unreadable observations while retaining real native lifetimes.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";
import { gone } from "./fixtures/process-tree.js";
import { expectCleanupEvidence, expectOrphanReclaimed } from "./fixtures/cleanup-evidence.js";

const fixture = fileURLToPath(new URL("fixtures/shutdown-orphan-tree.mjs", import.meta.url));
afterEach(() => { vi.restoreAllMocks(); });

// oxlint-disable-next-line eslint/max-statements -- The intermediate parent exits between capture and shutdown, leaving an actual independent tool.
test.each([false, true])("prepared cleanup follows a tool after its intermediate parent exits (unreadable: %s)", async (unreadable) => {
  const child = spawnLineProcess(process.execPath, [fixture], { killTree: true });
  const ready = Promise.withResolvers<{ middle: number; tool: number }>();
  const orphaned = Promise.withResolvers<void>();
  child.onLine(line => {
    if (line === "orphaned") { orphaned.resolve(); return; }
    const value = asRecord(JSON.parse(line));
    if (typeof value?.middle === "number" && typeof value.tool === "number") { ready.resolve({ middle: value.middle, tool: value.tool }); }
  });
  const exits: { code: number | null; reason?: string }[] = [];
  child.onExit((code, reason) => { exits.push({ code, ...(reason === undefined ? {} : { reason }) }); });
  let owned: { middle: number; tool: number } | undefined = undefined;
  try {
    owned = await ready.promise;
    expect(await gone(owned.middle, 50)).toBe(false); expect(await gone(owned.tool, 50)).toBe(false);
    const read = vi.spyOn(tables, "observeProcessTableAsync");
    if (unreadable) { read.mockResolvedValue({ ok: false, source: "windows", reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 }); }
    await Promise.all([child.prepareShutdown(), child.prepareShutdown()]);
    expect(read).toHaveBeenCalledTimes(unreadable && process.platform !== "win32" ? 2 : 1);
    child.write("orphan\n"); await orphaned.promise;
    expect(await gone(owned.middle)).toBe(true); expect(await gone(owned.tool, 50)).toBe(false);
    child.kill(); await child.exited;
    expect(exits).toHaveLength(1);
    const evidence = child.diagnostics().cleanup;
    expectCleanupEvidence(evidence, exits[0]?.reason, { injectedTimeouts: unreadable ? [0, 1] : [] });
    const capture = evidence.observations.findLast(entry => entry.phase === "before_eof");
    expect(capture).toBeDefined();
    if (unreadable) { expect(capture?.ok).toBe(false); }
    await expectOrphanReclaimed(owned.tool, evidence, capture);
  } finally {
    vi.restoreAllMocks(); child.kill(); await child.exited;
    for (const pid of owned === undefined ? [] : [owned.middle, owned.tool]) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});

// oxlint-disable-next-line eslint/max-statements -- This ordinary kill must capture the tree before EOF even on Windows.
test("ordinary tree shutdown observes descendants before closing the root", async () => {
  const child = spawnLineProcess(process.execPath, [fixture], { killTree: true });
  const ready = Promise.withResolvers<{ middle: number; tool: number }>();
  child.onLine(line => { const value = asRecord(JSON.parse(line)); if (typeof value?.middle === "number" && typeof value.tool === "number") { ready.resolve({ middle: value.middle, tool: value.tool }); } });
  let owned: { middle: number; tool: number } | undefined = undefined;
  try {
    owned = await ready.promise;
    expect(await gone(owned.middle, 50)).toBe(false); expect(await gone(owned.tool, 50)).toBe(false);
    child.kill(); await child.exited;
    const evidence = child.diagnostics().cleanup;
    const exited = Promise.withResolvers<string | undefined>();
    child.onExit((_code, reason) => { exited.resolve(reason); });
    expectCleanupEvidence(evidence, await exited.promise);
    expect(evidence.observations[0]?.phase).toBe("before_eof");
    expect(await gone(owned.middle)).toBe(true); expect(await gone(owned.tool)).toBe(true);
  } finally {
    child.kill(); await child.exited;
    for (const pid of owned === undefined ? [] : [owned.middle, owned.tool]) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});
