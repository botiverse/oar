import { processTableSource } from "./process-table-async.js";
import { observeProcessTableWithin } from "./process-table-budget.js";
import type { ProcessTableFailure } from "./process-tree.js";

export type ProcessTablePreparation = { readonly status: "pending" }
  | ProcessTableFailure
  | { readonly ok: true; readonly source: "windows"; readonly elapsedMs: number; readonly skipped: number };

let preparation: ProcessTablePreparation | null = null;

/** Once per host, after a Windows tree-owning child successfully spawns.
 * Use the regular serial reader, retain metadata only, and never retry. */
export function prepareProcessTable(): void {
  if (processTableSource() !== "windows" || preparation !== null) { return; }
  preparation = { status: "pending" };
  void (async (): Promise<void> => {
    const result = await observeProcessTableWithin(5000, "windows", { background: true });
    preparation = result.ok
      ? { ok: true, source: "windows", elapsedMs: result.elapsedMs, skipped: result.skipped }
      : result;
  })();
}

export function processTablePreparation(): ProcessTablePreparation | undefined { return preparation === null ? undefined : { ...preparation }; }
