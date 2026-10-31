/** Missing execution evidence is never equivalent behavior. Paths are relative to each disposable cohort. */
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { executionMarker } from "./execution-observations.js";

function snapshots(row: JsonRecord, failures: string[]): unknown[] {
  const hooks = asRecord(row.evidence)?.hooks;
  const cwds = row.sessionCwds;
  if (!Array.isArray(row.errors) || row.errors.length > 0) { failures.push(`${String(row.placement)} observation errors: ${JSON.stringify(row.errors)}`); }
  if (!Array.isArray(hooks) || hooks.length === 0 || !Array.isArray(cwds) || cwds.length !== 2) {
    failures.push(`${String(row.placement)} missing hook or session evidence`); return [];
  }
  const seen = new Set<number>();
  const result = hooks.map(hook => {
    const value = asRecord(hook); const child = asRecord(value?.child);
    const owner = cwds.indexOf(value?.location); seen.add(owner);
    if (owner === -1 || child?.environmentMarker !== executionMarker || value?.environmentMarker !== executionMarker || typeof child.cwd !== "string") {
      failures.push(`${String(row.placement)} missing or invalid child environment: ${JSON.stringify(value)}`);
    }
    let cwd = child?.cwd;
    if (cwd === row.processHome) { cwd = "HOME"; }
    if (child?.cwd === value?.location) { cwd = "session"; }
    return { owner, cwd,
      environmentMarker: child?.environmentMarker };
  });
  if (!seen.has(0) || !seen.has(1)) { failures.push(`${String(row.placement)} missing one session's hook child`); }
  return result;
}
export function comparePluginEnvironment(shared: JsonRecord, isolated: JsonRecord): { passed: boolean; failures: string[] } {
  const failures: string[] = []; const a = snapshots(shared, failures); const b = snapshots(isolated, failures);
  if (JSON.stringify(a) !== JSON.stringify(b)) { failures.push(`Plugin child environment differs: shared=${JSON.stringify(a)} isolated=${JSON.stringify(b)}`); }
  return { passed: failures.length === 0, failures };
}
