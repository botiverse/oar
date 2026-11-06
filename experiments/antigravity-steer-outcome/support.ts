import assert from "node:assert/strict";
import { observeProcessTable, type ProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";

function processTable(): ProcessTable {
  const observation = observeProcessTable(); assert.ok(observation.ok);
  return observation.table;
}

/** Only the one direct worker of this probe's owned ACP process may be signalled. */
export function killOwnedWorker(pid: number): void {
  assert.equal(process.platform, "linux", "This probe uses Linux procfs identities");
  const table = processTable();
  const workers = [...table.values()].filter(entry => entry.ppid === pid);
  assert.equal(workers.length, 1);
  const [worker] = workers; assert.ok(worker !== undefined);
  const fresh = processTable();
  assert.deepEqual(fresh.get(pid), table.get(pid));
  assert.deepEqual(fresh.get(worker.pid), worker);
  process.kill(worker.pid, "SIGKILL");
}

export async function bounded<T>(work: Promise<T>): Promise<T> {
  const limit = Promise.withResolvers<never>();
  const timer = setTimeout(() => { limit.reject(new Error("Native steer probe timed out after 30 seconds")); }, 30_000);
  try { return await Promise.race([work, limit.promise]); }
  finally { clearTimeout(timer); }
}
