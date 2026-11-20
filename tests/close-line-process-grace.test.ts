import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { closeLineProcess } from "../packages/oar/src/shared/executable/close.js";
import { qoderDaemonSession } from "../packages/oar/src/runtimes/qoder/daemon.js";
import { spawnLineProcess, type LineProcess } from "../packages/oar/src/shared/executable/process.js";
import { gone, type ProcessIdentity, reportedCleanupTree, signalFixture } from "./fixtures/process-tree.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const eofRootFixture = path.join(import.meta.dirname, "fixtures/adapter-eof-root.ts");
const treeFixture = path.join(import.meta.dirname, "fixtures/async-cleanup-tree.mjs");

interface EofProbe {
  readonly child: LineProcess;
  readonly directory: string;
  readonly stop: string;
  readonly ready: Promise<void>;
  readonly eofAt: Promise<number>;
  readonly sawSigterm: () => boolean;
}

async function spawnEofProbe(shutdown?: "stdin"): Promise<EofProbe> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-eof-grace-"));
  const stop = path.join(directory, "exit");
  const child = spawnLineProcess(process.execPath, [eofRootFixture, stop], {
    killTree: true,
    ...(shutdown === undefined ? {} : { shutdown }),
    env: { ...process.env, OAR_IGNORE_SIGTERM: "1" },
  });
  const ready = Promise.withResolvers<void>();
  const eofAt = Promise.withResolvers<number>();
  let sigterm = false;
  child.onLine((line) => {
    if (line === "ready") { ready.resolve(); }
    if (line === "eof") { eofAt.resolve(performance.now()); }
    if (line === "sigterm") { sigterm = true; }
  });
  return { child, directory, stop, ready: ready.promise, eofAt: eofAt.promise, sawSigterm: () => sigterm };
}

// Windows CIM process-table reads and taskkill add ~1-1.6 s of fixed cleanup
// overhead under parallel CI load; a 4 s grace keeps 1.85x strictly below 2x
// while leaving >3 s of headroom for that fixed overhead.
const timingGraceMs = process.platform === "win32" ? 4000 : 1500;

test.each(["line", "line-stdin", "daemon"] as const)(
  "%s closeLineProcess forces after one grace period without a second SIGTERM window",
  // oxlint-disable-next-line eslint/max-statements -- End-to-end EOF-to-force timing, signal and cleanup check.
  async (kind) => {
    const graceMs = timingGraceMs;
    vi.stubEnv("OAR_KILL_GRACE_MS", String(graceMs));
    const probe = await spawnEofProbe(kind === "line-stdin" ? "stdin" : undefined);
    try {
      await probe.ready;
      const target = kind === "daemon"
        ? await qoderDaemonSession(probe.child, "eof-session", [], probe.directory, {})
        : probe.child;
      await closeLineProcess(target);
      const settledAt = performance.now();
      const afterEof = settledAt - await probe.eofAt;
      expect(probe.sawSigterm()).toBe(false);
      expect(afterEof).toBeGreaterThanOrEqual(graceMs * 0.8);
      expect(afterEof).toBeLessThan(graceMs * 1.85);
      expect(await probe.child.exited).not.toBe(0);
      if (process.platform !== "win32") { expect(probe.child.diagnostics().signal).toBe("SIGKILL"); }
    } finally {
      await writeFile(probe.stop, "exit"); probe.child.forceKill(); await probe.child.exited;
      await rm(probe.directory, { recursive: true, force: true });
    }
  },
  30_000,
);

// oxlint-disable-next-line eslint/max-statements -- Verify forced EOF timeout still reaps detached descendants in one grace.
test("closeLineProcess force-kill reaps detached descendants after one grace period", async () => {
  const graceMs = timingGraceMs;
  vi.stubEnv("OAR_KILL_GRACE_MS", String(graceMs));
  const child = spawnLineProcess(process.execPath, [treeFixture], {
    killTree: true,
    env: { ...process.env, OAR_TREE_IGNORE_EOF: "1" },
  });
  const ready = Promise.withResolvers<string>();
  child.onLine((line) => { if (line.startsWith("{")) { ready.resolve(line); } });
  let root: ProcessIdentity | undefined = undefined;
  let tool: ProcessIdentity | undefined = undefined;
  try {
    ({ root, tool } = reportedCleanupTree(await ready.promise));
    expect(await gone(tool, 50)).toBe(false);
    const started = performance.now();
    await closeLineProcess(child);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(graceMs * 0.8);
    expect(elapsed).toBeLessThan(graceMs * 1.85);
    expect(await gone(root, 1000)).toBe(true);
    expect(await gone(tool, 1000)).toBe(true);
    expect(child.diagnostics().cleanup?.status).toBe("observed");
  } finally {
    child.forceKill(); await child.exited;
    if (root !== undefined) { signalFixture(root); }
    if (tool !== undefined) { signalFixture(tool); }
  }
}, 30_000);

// oxlint-disable-next-line eslint/max-statements -- Verify a mid-EOF kill() cannot push force escalation past the original EOF deadline.
test.skipIf(process.platform === "win32")("concurrent kill() during closeLineProcess still forces at the EOF grace deadline", async () => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "10000");
  const probe = await spawnEofProbe();
  try {
    await probe.ready;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closed = closeLineProcess(probe.child);
    await probe.eofAt;
    await vi.advanceTimersByTimeAsync(6000);
    probe.child.kill();
    await vi.advanceTimersByTimeAsync(4000);
    vi.useRealTimers();
    await closed;
    expect(probe.child.diagnostics().signal).toBe("SIGKILL");
  } finally {
    vi.useRealTimers();
    await writeFile(probe.stop, "exit"); probe.child.forceKill(); await probe.child.exited;
    await rm(probe.directory, { recursive: true, force: true });
  }
}, 20_000);
