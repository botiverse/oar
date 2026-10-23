/** Real Qwen, synthetic provider: distinguish initialize acknowledgement from extension readiness. */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promptAndWait, qwenSession } from "../../packages/oar/src/index.js";
import { startQwenAimock } from "../../sea-trial/harness/qwen-aimock.js";

const [binary] = process.argv.slice(2);
assert.ok(binary !== undefined && binary !== "", "usage: lock-lifetime.ts <qwen-binary>");
const env = await startQwenAimock();
const installation = { kind: "available", via: "executable", command: path.resolve(binary), version: "probe" } as const;
const lock = path.join(env.env.HOME ?? "", ".qwen", "extension-store", "lock.lock");
const facts: Record<string, unknown>[] = [];
try {
  // Use a completed turn as the prior warmup, then dispose the process cleanly.
  const warm = await qwenSession(installation, { cwd: env.cwd, env: env.env });
  try {
    const result = await promptAndWait(warm, "warmup");
    assert.ok(result.kind === "ended" && result.outcome.kind === "completed");
  }
  finally { await warm.dispose(); }
  await mkdir(lock);
  const before = env.raw.length;
  const start = Date.now();
  const session = await qwenSession(installation, { cwd: env.cwd, env: env.env });
  facts.push({ phase: "warm-home initialize with held lock", elapsedMs: Date.now() - start, requests: env.raw.length - before });
  try {
    const first = promptAndWait(session, "first after initialize", { timeoutMs: 40_000 });
    await sleep(300);
    assert.equal(env.raw.length, before);
    facts.push({ phase: "first prompt blocked after initialize", lockHeld: true, requests: 0 });
    await rm(lock, { recursive: true });
    const result = await first;
    assert.ok(result.kind === "ended" && result.outcome.kind === "completed");
    facts.push({ phase: "first prompt after releasing lock", outcome: result.outcome.kind });
    await mkdir(lock);
    const next = await promptAndWait(session, "second with external lock", { timeoutMs: 40_000 });
    assert.ok(next.kind === "ended" && next.outcome.kind === "completed");
    facts.push({ phase: "ordinary later prompt with held lock", outcome: next.outcome.kind });
    // This proves only this ordinary later prompt. Extension refresh/control
    // operations can acquire the store lock again; no lifetime-wide guarantee.
  } finally { await rm(lock, { recursive: true, force: true }); await session.dispose(); }
} finally {
  await env.stop();
  process.stdout.write(`${JSON.stringify({ runtime: "Qwen", facts }, null, 2)}\n`);
}
