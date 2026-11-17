/** Compare creation alone with switching on the same deliberately selected profile. */
import { isDeepStrictEqual } from "node:util";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { probeRealMenus } from "./probe.js";
import { probeDefaultPersistence, probeFailed } from "./default-persistence.js";


function changes(report: JsonRecord): JsonRecord[] {
  return asRecordList(asRecord(report.fileInventory)?.changed);
}

function comparisonPath(entry: JsonRecord): unknown {
  return typeof entry.path === "string" ? entry.path.replace(/(?<prefix>\/log\/acp-(?:front|worker))-\d{8}_\d{6}-\d+\.log$/u, "$<prefix>-[run].log") : entry.path;
}

export function compareRunWrites(baseline: JsonRecord, switched: JsonRecord): JsonRecord {
  const first = changes(baseline), second = changes(switched);
  const firstPaths = new Set(first.map(entry => comparisonPath(entry)));
  const secondPaths = new Set(second.map(entry => comparisonPath(entry)));
  return {
    complete: asRecord(baseline.fileInventory)?.complete === true && asRecord(switched.fileInventory)?.complete === true,
    // Group redacted UUIDs and timestamp/PID log names; retain every entry in each run.
    sameInitialSelection: isDeepStrictEqual(baseline.initial, switched.initial),
    sameInitialCatalog: isDeepStrictEqual(baseline.availableModelIds, switched.availableModelIds),
    baselineOnly: first.filter(entry => !secondPaths.has(comparisonPath(entry))),
    switchesOnly: second.filter(entry => !firstPaths.has(comparisonPath(entry))),
    changedInBoth: [...firstPaths].filter(relative => secondPaths.has(relative)).map(relative => ({ path: relative,
      baseline: first.filter(entry => comparisonPath(entry) === relative), switches: second.filter(entry => comparisonPath(entry) === relative) })),
  };
}

export async function probeMenuPersistence(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{
  schema: number; baseline: JsonRecord; switches: JsonRecord | null; difference: JsonRecord | null; persistence: JsonRecord | null; elapsedMs: number;
}> {
  const started = performance.now();
  const baseline = await probeRealMenus({ command, cwd, env, mode: "baseline" });
  // Do not mutate an account after a failed baseline or failed native close.
  const switches = probeFailed(baseline) ? null : await probeRealMenus({ command, cwd, env, mode: "switches" });
  const persistence = switches === null || probeFailed(switches) ? null :
    await probeDefaultPersistence({ command, cwd, env }, baseline);
  return { schema: 2, baseline, switches, persistence, difference: switches === null ? null : compareRunWrites(baseline, switches),
    elapsedMs: performance.now() - started };
}
