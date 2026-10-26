/* oxlint-disable oxc/no-map-spread -- Project immutable native metadata without modifying the RPC response. */
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import type { CommandEntry, InventoryReader, SkillEntry } from "../../../contracts/inventory.js";
import type { ModelLister } from "../../../contracts/list-models.js";
import { inventoryOk, unavailableInventory, unsupportedInventory, workspaceScope } from "../../../shared/inventory.js";
import { projectPiModels } from "../model-projection.js";
import type { PiRuntimeOptions } from "../options.js";
import { piRpcReadTimeout, readPiRpc } from "./read.js";

type RpcSlashCommand = Extract<RpcResponse, { command: "get_commands"; success: true }>["data"]["commands"][number];

/** RPC reports invocation metadata, not template bodies or SDK-only diagnostics. */
export function piRpcCommands(commands: readonly RpcSlashCommand[]): CommandEntry[] {
  return commands.filter((command) => command.source !== "skill").map((command) => ({
    name: command.name, source: command.source,
    ...(command.description === undefined ? {} : { description: command.description }),
  }));
}

export function piRpcSkills(commands: readonly RpcSlashCommand[]): SkillEntry[] {
  return commands.filter((command) => command.source === "skill").map((command) => ({
    name: command.name.replace(/^skill:/u, ""),
    path: command.sourceInfo.path, source: command.sourceInfo.source,
    ...(command.description === undefined ? {} : { description: command.description }),
  }));
}

function inventory<T>(runtime: PiRuntimeOptions, project: (commands: readonly RpcSlashCommand[]) => T[]): InventoryReader<T> {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") { return unsupportedInventory("installation_unsupported", "Pi inventory requires the bundled SDK"); }
    piRpcReadTimeout(options);
    try {
      return await readPiRpc(runtime, options, async (rpc) => {
        const response = await rpc.control.request({ type: "get_commands" });
        if (!response.success || response.command !== "get_commands") { throw new Error("Pi did not return its command catalog"); }
        // RPC omits discovery diagnostics, so it cannot prove a complete load.
        return inventoryOk(workspaceScope(options), "discovered", project(response.data.commands), true);
      });
    } catch (error) {
      return error instanceof DOMException && error.name === "TimeoutError"
        ? unavailableInventory("timeout", "Native inventory query timed out")
        : unavailableInventory("query_failed", "Native inventory query failed");
    }
  };
}

export const piRpcSkillReader = (runtime: PiRuntimeOptions): InventoryReader<SkillEntry> => inventory(runtime, piRpcSkills);
export const piRpcCommandReader = (runtime: PiRuntimeOptions): InventoryReader<CommandEntry> => inventory(runtime, piRpcCommands);

export const piRpcModelLister = (runtime: PiRuntimeOptions): ModelLister => async (installation, options = {}) => {
  if (installation.via !== "bundled") { return { kind: "unsupported", reason: "Pi model listing requires the bundled SDK" }; }
  piRpcReadTimeout(options);
  try {
    return await readPiRpc(runtime, options, async (rpc) => {
      const response = await rpc.control.request({ type: "get_available_models" });
      if (!response.success || response.command !== "get_available_models") { throw new Error("Pi did not return its available models"); }
      const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
      return { kind: "ok", models: projectPiModels(response.data.models, getSupportedThinkingLevels) };
    });
  } catch (error) {
    // oxlint-disable-next-line eslint/preserve-caught-error -- Native failures can contain credentials, including in cause.
    throw new Error(error instanceof DOMException && error.name === "TimeoutError"
      ? "Pi RPC model listing timed out" : "Pi RPC could not list available models");
  }
};
