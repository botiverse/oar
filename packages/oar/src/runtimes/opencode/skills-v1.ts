import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryResult, InventoryScope, SkillEntry } from "../../contracts/inventory.js";
import { runExecutable } from "../../shared/executable/run.js";
import { inventoryOk, unavailableInventory } from "../../shared/inventory.js";
import { parseJson } from "../../shared/json.js";
import { skillFailureReason } from "./skill-diagnostic.js";

/** v1 exits without draining large pipe writes; a regular file preserves the complete catalog. */
export async function legacySkills(command: string, scope: InventoryScope, env: NodeJS.ProcessEnv, signal: AbortSignal, project: (value: unknown) => Promise<SkillEntry[]>): Promise<InventoryResult<SkillEntry>> {
  const directory = await mkdtemp(join(tmpdir(), "oar-opencode-skills-"));
  try {
    const path = join(directory, "catalog.json");
    const output = await open(path, "wx", 0o600);
    try {
      signal.throwIfAborted();
      const result = await runExecutable(command, ["debug", "skill"], { cwd: scope.cwd, env, signal, timeoutMs: 0, stdoutFd: output.fd });
      if (!result.ok) { return unavailableInventory("query_failed", skillFailureReason(result.exitCode, result.stderr, env)); }
      signal.throwIfAborted();
      const bytes = await readFile(path);
      const value = parseJson(bytes.toString("utf8"));
      try { return inventoryOk(scope, "discovered", await project(value)); }
      catch { return unavailableInventory("query_failed", skillFailureReason(0, result.stderr, env, bytes.length)); }
    } finally { await output.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
