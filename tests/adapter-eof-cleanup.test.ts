import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { closeLineProcess } from "../packages/oar/src/shared/executable/close.js";
import { qoderDaemonSession } from "../packages/oar/src/runtimes/qoder/daemon.js";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";
// oxlint-disable-next-line import/no-namespace -- Gate only the read, retaining native EOF and exit behavior.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const failure: ProcessTableObservation = { ok: false, source: "windows", reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 };

// oxlint-disable-next-line eslint/max-statements -- Each EOF path captures before exit and retains a failed observation on native exit.
test.each(["line", "daemon"])("%s EOF retains a failed capture observation when the root exits natively", async (kind) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-eof-cleanup-"));
  const stop = path.join(directory, "exit");
  const child = spawnLineProcess(process.execPath, [path.join(import.meta.dirname, "fixtures/adapter-eof-root.ts"), stop], { killTree: true });
  const ready = Promise.withResolvers<void>();
  const eof = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const exits: { code: number | null; reason: string | undefined }[] = [];
  child.onLine((line) => { if (line === "ready") { ready.resolve(); } if (line === "eof") { eof.resolve(); } });
  child.onExit((code, reason) => { exits.push({ code, reason }); });
  try {
    await ready.promise;
    const daemon = kind === "daemon" ? await qoderDaemonSession(child, "eof-session", [], directory, {}) : null;
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async () => { entered.resolve(); return gate.promise; });
    if (daemon === null) {
      const closed = closeLineProcess(child);
      await entered.promise;
      expect(read).toHaveBeenCalledOnce();
      gate.resolve(failure);
      await eof.promise;
      await writeFile(stop, "exit");
      expect(await child.exited).toBe(0);
      await closed;
    } else {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Exercise final() directly: closeLineProcess's own mark must not mask a missing daemon mark.
      daemon.stdin.end();
      setTimeout(() => { daemon.kill(); }, 5000);
      await eof.promise;
      await vi.advanceTimersByTimeAsync(5000);
      await entered.promise;
      vi.useRealTimers();
      expect(read).toHaveBeenCalledOnce();
      await writeFile(stop, "exit");
      await vi.waitFor(() => { expect(child.diagnostics().exitCode).toBe(0); }, { timeout: 5000 });
      expect(exits).toEqual([]);
      gate.resolve(failure);
      expect(await child.exited).toBe(0);
    }
    expect(exits).toHaveLength(1);
    expect(exits[0]?.reason).toContain("before_eof windows: timeout");
    expect(child.diagnostics().cleanup?.status).toBe("unverified");
  } finally {
    vi.useRealTimers(); gate.resolve(failure); vi.restoreAllMocks();
    await writeFile(stop, "exit"); child.kill(); await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
