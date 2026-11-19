import { observeProcessTableWithin } from "./process-table-budget.js";
import type { ProcessEntry, ProcessTableObservation } from "./process-tree.js";

/** A delivered signal can precede process exit. Verify only the identities we tried to stop. */
export async function verifyDescendantExit(entries: readonly ProcessEntry[], deadline: number): Promise<ProcessTableObservation> {
  let pending = entries;
  let pauseMs = 25;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Each observation must be newer than the previous one.
    const result = await observeProcessTableWithin(Math.max(0, deadline - performance.now()));
    if (!result.ok) { return result; }
    if (pending.some(entry => result.unreadable?.has(entry.pid) === true)) {
      return { ok: false, source: result.source, elapsedMs: result.elapsedMs, reason: "descendant_unreadable" };
    }
    pending = pending.filter(entry => {
      const now = result.table.get(entry.pid);
      return now?.start === entry.start && now.zombie !== true;
    });
    if (pending.length === 0) { return result; }
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      const waitMs = Math.min(pauseMs, remaining);
      // oxlint-disable-next-line no-await-in-loop -- Back off while a signalled identity remains live.
      await new Promise<void>(resolve => { setTimeout(resolve, waitMs); });
    }
    if (performance.now() >= deadline) {
      return { ok: false, source: result.source, elapsedMs: result.elapsedMs, reason: "descendant_still_running" };
    }
    pauseMs = Math.min(pauseMs * 2, 250);
  }
}
