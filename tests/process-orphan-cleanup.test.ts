import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Inject unreadable observations while retaining real native lifetimes.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";
import { gone } from "./fixtures/process-tree.js";

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
    expect(child.diagnostics().cleanup?.status).toBe(unreadable ? "unverified" : "observed");
    if (unreadable) { expect(exits[0]?.reason).toContain("before_eof windows: timeout"); }
    else { expect(exits[0]?.reason).toBeUndefined(); }
    expect(await gone(owned.tool, unreadable ? 50 : 5000)).toBe(!unreadable);
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
    expect(child.diagnostics().cleanup?.status).toBe("observed");
    expect(child.diagnostics().cleanup?.observations[0]).toMatchObject({ ok: true, phase: "before_eof" });
    expect(await gone(owned.middle)).toBe(true); expect(await gone(owned.tool)).toBe(true);
  } finally {
    child.kill(); await child.exited;
    for (const pid of owned === undefined ? [] : [owned.middle, owned.tool]) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});
