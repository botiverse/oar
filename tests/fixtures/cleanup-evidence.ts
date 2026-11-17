import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import type { ProcessCleanupDiagnostics, Observation } from "../../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";
// oxlint-disable-next-line import/no-namespace -- Observe the actual cleanup instance without replacing any read or deadline.
import * as cleanup from "../../packages/oar/src/shared/executable/process-cleanup.js";
import { gone } from "./process-tree.js";

const reports: unknown[] = [];
afterEach(async context => {
  const retained = reports.splice(0);
  if (retained.length === 0) { return; }
  const dir = path.join(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "cancellation-timing");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `cleanup-${randomUUID()}.json`), `${JSON.stringify({ test: context.task.name, reports: retained })}\n`);
});

/** For fixtures with exactly one managed tree, including sessions that hide their process. */
export function captureCleanupEvidence(): () => ProcessCleanupDiagnostics {
  const instances: ReturnType<typeof cleanup.processTreeCleanup>[] = [];
  const create = cleanup.processTreeCleanup;
  vi.spyOn(cleanup, "processTreeCleanup").mockImplementation((...args) => {
    const instance = create(...args);
    instances.push(instance);
    return instance;
  });
  return () => {
    expect(instances, "expected exactly the fixture's own cleanup instance").toHaveLength(1);
    const [instance] = instances;
    assert.ok(instance);
    return instance.diagnostics();
  };
}

/** An unverified exit needs this operation's timeout, not just a Windows host or warning. */
// oxlint-disable-next-line eslint/max-statements -- Validate each failure and its exact exit representation together.
export function expectCleanupEvidence(
  evidence: ProcessCleanupDiagnostics | undefined,
  reason: string | undefined,
  options: { platform?: NodeJS.Platform; injectedTimeouts?: readonly number[] } = {},
): asserts evidence is ProcessCleanupDiagnostics {
  const diagnostic = JSON.stringify({ evidence, reason });
  reports.push({ evidence, reason });
  assert.ok(evidence, diagnostic);
  expect(evidence.observations.length, diagnostic).toBeGreaterThan(0);
  const failures = evidence.observations.filter(entry => !entry.ok);
  // oxlint-disable-next-line eslint/max-statements -- One observation's source, phase budget and elapsed time must agree.
  evidence.observations.forEach((entry, index) => {
    if (entry.ok) { return; }
    if (options.injectedTimeouts?.includes(index) !== true) {
      expect(options.platform ?? process.platform, diagnostic).toBe("win32");
      expect(entry.source, diagnostic).toBe("windows");
    }
    expect(entry.reason, diagnostic).toBe("timeout");
    if (entry.phase === "before_eof") {
      // A retry shares the original five-second capture deadline.
      expect(entry.timeoutMs, diagnostic).toBeGreaterThan(0);
      expect(entry.timeoutMs, diagnostic).toBeLessThanOrEqual(5000);
    } else { expect(entry.timeoutMs, diagnostic).toBe(entry.phase === "before_cancel" ? 1000 : 5000); }
    expect(Number.isFinite(entry.elapsedMs), diagnostic).toBe(true);
    expect(entry.elapsedMs, diagnostic).toBeGreaterThanOrEqual(entry.timeoutMs ?? Infinity);
  });
  expect(evidence.status, diagnostic).toBe(failures.length === 0 ? "observed" : "unverified");
  const expectedReason = failures.length === 0 ? undefined : `Descendant cleanup could not be verified: ${failures.map(entry =>
    `${entry.phase} ${entry.source}: timeout (${entry.elapsedMs.toFixed(0)} ms${entry.code === undefined ? "" : `, ${entry.code}`}${entry.exitCode === undefined ? "" : `, exit ${String(entry.exitCode)}`}${entry.signal === undefined ? "" : `, ${entry.signal}`})`).join("; ")}`;
  expect(reason, diagnostic).toBe(expectedReason);
  if (failures.length > 0) { console.log("OAR_CLEANUP_EVIDENCE", diagnostic); }
}

/** Check the real orphan even when capture timed out; finalizers reap any survivors separately. */
export async function expectOrphanReclaimed(pid: number | undefined, evidence: ProcessCleanupDiagnostics, capture: Observation | undefined): Promise<void> {
  assert.ok(pid !== undefined && Number.isInteger(pid) && pid > 0);
  assert.ok(capture);
  const reclaimed = await gone(pid, capture.ok ? 5000 : 100);
  const diagnostic = JSON.stringify({ evidence, capture, reclaimed });
  reports.push({ evidence, capture, reclaimed });
  const revalidationTimedOut = evidence.observations.some(entry => !entry.ok && entry.reason === "timeout"
    && (entry.phase === "after_exit" || entry.phase === "before_force"));
  // A later read cannot recover an orphan whose parent chain was already severed.
  // With captured identity and successful revalidation the tool must be gone.
  if (!capture.ok || !revalidationTimedOut) { expect(reclaimed, diagnostic).toBe(capture.ok); }
  if (evidence.status === "unverified") { console.log("OAR_ORPHAN_RECLAMATION", diagnostic); }
}
