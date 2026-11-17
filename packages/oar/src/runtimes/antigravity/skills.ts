import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { remainingMs } from "../../shared/deadline.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { inventoryOk, named, nativeRows, textField, unavailableInventory, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { readAntigravityAuthStatus } from "./auth.js";
import { antigravityUsesDefaultState } from "./state-directory.js";
import { antigravityVersionPreflight } from "./version.js";

function optionalBoolean(row: JsonRecord, key: string): boolean | undefined {
  const value = row[key];
  if (value !== undefined && typeof value !== "boolean") { throw new TypeError("Invalid native skill flag"); }
  return value;
}
function project(row: JsonRecord): SkillEntry {
  const builtin = optionalBoolean(row, "builtin");
  const modelInvocable = optionalBoolean(row, "model_invocable");
  return { name: named(row), ...textField("description", row.description), ...textField("path", row.path), ...textField("plugin", row.plugin),
    ...(builtin === true ? { scope: "builtin" as const } : {}),
    ...(modelInvocable === undefined ? {} : { disableModelInvocation: !modelInvocable }) };
}
function catalog(stdout: string): SkillEntry[] {
  const payload = asRecord(parseJson(stdout));
  const command = asRecord(payload?.command);
  if (payload?.status !== "SUCCESS" || payload.conversation_id !== "" || payload.num_turns !== 0 || command?.name !== "skills") {
    throw new TypeError("Native CLI did not return a read-only skill catalog");
  }
  return nativeRows(asRecord(command.data)?.skills).map(row => project(row));
}

/** Native read-only slash command, guarded against login and automatic installation changes. */
export const antigravitySkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") { return unsupportedInventory("installation_unsupported", "Antigravity skill discovery requires an executable."); }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  // agy compares the literal string "true". "1" still launches its updater.
  const overlay = { ...options.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
  const env = sessionEnvironment(overlay);
  if (!antigravityUsesDefaultState(env)) {
    return unsupportedInventory("scope_unavailable", "agy print mode cannot select GEMINI_HOME; isolate HOME (USERPROFILE on Windows) to read skills.");
  }
  const scope = workspaceScope(options);
  const deadline = Date.now() + timeoutMs;
  try {
    return await withQueryDeadline("Antigravity skills", timeoutMs, async signal => {
      const version = await antigravityVersionPreflight(installation, env, { timeoutMs: remainingMs(deadline, "Antigravity skills"), signal });
      if (version.kind === "unsupported") { return version; }
      const auth = await readAntigravityAuthStatus(installation, { env: overlay, timeoutMs: remainingMs(deadline, "Antigravity skills"), signal });
      if (auth.kind === "logged_out") { return unavailableInventory("not_authenticated", "Sign in to Antigravity to read its skills."); }
      if (auth.kind !== "logged_in") { return unavailableInventory("query_failed", "Antigravity could not confirm authentication for skill discovery."); }
      const result = await runExecutable(installation.command, ["--output-format", "json", "--print=/skills"], {
        cwd: scope.cwd, env, timeoutMs: remainingMs(deadline, "Antigravity skills"), signal,
      });
      if (!result.ok) { throw new Error("Native skill query failed"); }
      return inventoryOk(scope, "discovered", catalog(result.stdout));
    }, unavailableInventory("timeout", "Antigravity skill query timed out."));
  } catch { return unavailableInventory("query_failed", "Antigravity skill query failed."); }
};
