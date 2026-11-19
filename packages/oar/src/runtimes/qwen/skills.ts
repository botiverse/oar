import { RequestError, type AnyMessage } from "@agentclientprotocol/sdk";
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { createAcpClient, methods, startAcpProcess } from "../../shared/acp/process.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unavailableInventory, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Consume only solicited replies. Native notifications and error details stay private. */
function response(message: AnyMessage, pending: Set<string | number>): AnyMessage | undefined {
  const row = asRecord(message);
  if (row?.jsonrpc !== "2.0" || "method" in row || (typeof row.id !== "string" && typeof row.id !== "number") || !pending.has(row.id)) { return undefined; }
  const error = asRecord(row.error);
  if (error !== null && typeof error.code === "number") {
    pending.delete(row.id);
    return { jsonrpc: "2.0", id: row.id, error: { code: error.code, message: "Qwen skill query failed" } };
  }
  if (!("result" in row)) { return undefined; }
  pending.delete(row.id);
  return { jsonrpc: "2.0", id: row.id, result: row.result };
}
function project(row: JsonRecord): SkillEntry {
  if (row.kind !== "skill" || (row.status !== "ok" && row.status !== "disabled") || typeof row.level !== "string" || typeof row.modelInvocable !== "boolean") {
    throw new TypeError("Invalid native skill metadata");
  }
  return { name: named(row), ...textField("description", row.description), ...textField("path", row.installedPath),
    source: row.level, ...skillScope(row.level, { bundled: "builtin", user: "user", project: "project", extension: "other" }),
    ...textField("plugin", row.extensionName), ...boolField("userInvocable", row.userInvocable), enabled: row.status === "ok", disableModelInvocation: !row.modelInvocable };
}

/** Workspace catalog before any session, prompt, authentication or provider connection request. */
export const qwenSkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") { return unsupportedInventory("installation_unsupported", "Qwen skill discovery requires an executable."); }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const scope = workspaceScope(options);
  const pending = new Set<string | number>();
  const result = await inventoryRead(async (_signal, own) => {
    const child = own(startAcpProcess(installation.command, ["--acp"], createAcpClient({ name: "oar-qwen-skills" }), {
      cwd: scope.cwd, env: sessionEnvironment(options.env), inheritStderr: false, redact: () => "Qwen skill query failed",
      incoming: message => response(message, pending),
      outgoing: message => { if ("id" in message && "method" in message && message.id !== null) { pending.add(message.id); } },
    }));
    await child.spawned;
    await child.connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    let payload: JsonRecord | null = null;
    try { payload = asRecord(await child.connection.agent.request("qwen/status/workspace/skills", {})); }
    catch (error) {
      if (error instanceof RequestError && error.code === -32_601) { return unsupportedInventory("native_query_unavailable", "This Qwen version has no workspace skill query."); }
      throw error;
    }
    if (payload?.v !== 1 || payload.initialized !== true || typeof payload.workspaceCwd !== "string") {
      return unavailableInventory("query_failed", "Qwen did not initialize its skill catalog.");
    }
    const errors = payload.errors === undefined ? [] : nativeRows(payload.errors);
    return inventoryOk(scope, "discovered", nativeRows(payload.skills).map(row => project(row)), errors.length > 0);
  }, timeoutMs);
  return result;
};
