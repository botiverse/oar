/* oxlint-disable oxc/no-map-spread -- Project only native skill metadata. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { readExecutableVersion } from "../../shared/executable/index.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unavailableInventory, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { DshCommandError, dshControl } from "./control.js";
import { dshEnvironment, launchDsh } from "./launch.js";
import { profileWaitReason, type DshProfileWait } from "./profile-startup.js";
import { dshVersionUnsupported } from "./version.js";

function project(row: JsonRecord): SkillEntry {
  const invocation = asRecord(row.invocation);
  return {
    name: named(row), ...textField("description", row.description), ...textField("path", row.path),
    ...textField("source", row.source), ...skillScope(row.source, {
      bundled: "builtin", custom: "other", runtime: "other", "user-dsh": "user", "user-agents": "user", "project-dsh": "project", "project-agents": "project",
    }),
    ...boolField("userInvocable", invocation?.userInvocable),
    ...(typeof invocation?.modelInvocable === "boolean" ? { disableModelInvocation: !invocation.modelInvocable } : {}),
  };
}

/** The native global catalog for this cwd/profile, without creating an agent or invoking a skill. */
export const dshSkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") { return unsupportedInventory("installation_unsupported", "DSH skill discovery requires an executable"); }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const profileWait: DshProfileWait = {};
  const result = await inventoryRead(async (signal, own) => {
    const env = dshEnvironment(options.env);
    const version = installation.version ?? await readExecutableVersion(installation.command, timeoutMs, undefined, env, signal);
    signal.throwIfAborted();
    const refusal = dshVersionUnsupported(version);
    if (refusal !== null) { return refusal; }
    const scope = workspaceScope(options);
    const launched = await launchDsh(installation.command, scope.cwd, env, { signal, profileWait }).catch(() => null);
    if (launched === null) { return unavailableInventory("query_failed", "Native inventory query failed"); }
    own(launched.child);
    const control = dshControl(launched.child, () => {}, undefined, launched.profileLoaded);
    await control.ready;
    let snapshot: JsonRecord = {};
    try { snapshot = await control.request("skills", { cwd: scope.cwd }, timeoutMs); }
    catch (error) {
      if (error instanceof DshCommandError && error.code === "native_method_unavailable") {
        return unsupportedInventory("native_query_unavailable", "This DSH does not expose a native skill snapshot");
      }
      throw error;
    }
    if (typeof snapshot.complete !== "boolean") { throw new TypeError("DSH skill snapshot has no completeness flag"); }
    return inventoryOk(scope, "discovered", nativeRows(snapshot.skills).map(row => project(row)), !snapshot.complete);
  }, timeoutMs);
  const reason = profileWaitReason(profileWait);
  return result.kind === "unavailable" && result.code === "timeout" && reason !== undefined ? unavailableInventory("timeout", reason) : result;
};
