/** Per-platform native child environment evidence; missing observations and differences fail. */
/* oxlint-disable no-await-in-loop, import/max-dependencies -- Sequential native cohorts compose observations and the standard Windows preparation. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { observeMcpWorkingDirectory } from "./mcp-working-directory-probe.js";
import { observeGrokHookWorkingDirectory } from "./grok-hook-working-directory-probe.js";
import { observeOpenCodeHookWorkingDirectory } from "./opencode-hook-working-directory-probe.js";
import { comparePluginEnvironment } from "./plugin-environment-comparison.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { recordProcessTableReads } from "./process-table.js";

const [runtime] = process.argv.slice(2); assert.ok(runtime === "grok" || runtime === "opencode");
const output = path.resolve(process.argv[3] ?? `oar-trial-run/execution-environment/${runtime}`);
await mkdir(output, { recursive: true });
recordProcessTableReads(path.join(output, "process-table-reads.jsonl"));
prepareWindowsProcessTable(path.join(output, "windows-process-table-preparation.jsonl"));
const failures: string[] = [];
async function retain(name: string, row: JsonRecord): Promise<void> {
  await writeFile(path.join(output, `${name}.json`), JSON.stringify(row, null, 2));
  if (!Array.isArray(row.errors) || row.errors.length > 0) { failures.push(`${name}: ${JSON.stringify(row.errors)}`); }
}
for (const source of ["session", "user"] as const) {
  for (const placement of ["shared", "isolated"] as const) {
    const row = await observeMcpWorkingDirectory(runtime, placement, source); const name = `mcp-${source}-${placement}`; await retain(name, row);
    if (JSON.stringify(row.sessionDirectoriesObserved) !== "[true,true]") { failures.push(`${name}: MCP child cwd differs or is missing: ${JSON.stringify(row.observations)}`); }
  }
}
for (const scope of ["user", "project"] as const) {
  const rows = new Map<string, JsonRecord>();
  for (const placement of ["shared", "isolated"] as const) {
    const row = runtime === "grok" ? await observeGrokHookWorkingDirectory(scope, placement) : await observeOpenCodeHookWorkingDirectory(scope, placement);
    await retain(`hooks-${scope}-${placement}`, row); rows.set(placement, row);
  }
  if (runtime === "opencode") {
    const shared = asRecord(rows.get("shared")); const isolated = asRecord(rows.get("isolated")); assert.ok(shared !== null && isolated !== null);
    failures.push(...comparePluginEnvironment(shared, isolated).failures.map(message => `${scope}: ${message}`));
  }
}
await writeFile(path.join(output, "comparison.json"), JSON.stringify({ runtime, passed: failures.length === 0, failures }, null, 2));
console.log(JSON.stringify({ runtime, passed: failures.length === 0, failures }));
if (failures.length > 0) { process.exitCode = 1; }
