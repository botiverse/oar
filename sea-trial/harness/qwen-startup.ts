import assert from "node:assert/strict";
import type { AvailableInstallation, Session } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { qwenSession } from "../../packages/oar/src/runtimes/qwen/session.js";
import { isolatedQwenEnvironment, type startQwenAimock } from "./qwen-aimock.js";
import { record } from "./trace.js";

let opening = 0;

/** Measure native initialization, including failures, without changing its deadline. */
export async function recordQwenOpen(mode: "isolated" | "suite", resume: boolean, open: () => Promise<Session>): Promise<Session> {
  const started = performance.now();
  opening += 1;
  const concurrentStarts = opening;
  record({ kind: "qwen_open_started", mode, resume, concurrentStarts });
  try {
    const session = await open();
    record({ kind: "qwen_open_completed", mode, resume, concurrentStarts, initializeMs: performance.now() - started, sessionId: session.id });
    return session;
  } catch (error) {
    record({ kind: "qwen_open_failed", mode, resume, concurrentStarts, elapsedMs: performance.now() - started,
      reason: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { opening -= 1; }
}

/** One new HOME before any suite cases; later cases use different HOMEs. */
export async function measureQwenStartup(installation: AvailableInstallation, aimock: Awaited<ReturnType<typeof startQwenAimock>>): Promise<void> {
  record({ kind: "qwen_startup_environment", platform: process.platform, arch: process.arch, node: process.version,
    version: installation.via === "executable" ? installation.version ?? null : null, suiteConcurrency: 2 });
  const env = await isolatedQwenEnvironment(aimock);
  const started = performance.now();
  const session = await recordQwenOpen("isolated", false, async () => {
    const opened = await qwenSession(installation, { cwd: aimock.cwd, env });
    return opened;
  });
  const initializeMs = performance.now() - started;
  try {
    const turnStarted = performance.now();
    const result = await promptAndWait(session, "hello", { timeoutMs: 30_000 });
    const firstTurnMs = performance.now() - turnStarted;
    const sample = { kind: "qwen_cold_start", platform: process.platform, arch: process.arch, node: process.version,
      initializeMs, firstTurnMs, outcome: result.kind === "ended" ? result.outcome : { kind: result.kind }, suiteConcurrency: 2 };
    record(sample);
    process.stdout.write(`${JSON.stringify(sample)}\n`);
    assert.ok(result.kind === "ended" && result.outcome.kind === "completed", JSON.stringify(result));
  } finally { await session.dispose(); }
}
