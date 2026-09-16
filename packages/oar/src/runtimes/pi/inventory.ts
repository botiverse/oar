/* oxlint-disable oxc/no-map-spread -- Project immutable native entries into credential-free records. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { InventoryReader, InventoryScope, InventoryResult, SkillEntry, ToolEntry } from "../../contracts/inventory.js";
import { asRecord } from "../../shared/json.js";
import { inventoryOk, inventoryRead, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

interface PiReaders {
  readonly skills: () => InventoryResult<SkillEntry>;
  readonly tools: () => InventoryResult<ToolEntry>;
}
function piInventories(session: AgentSession, scope: InventoryScope): PiReaders {
  return {
    skills: () => {
      const result = session.resourceLoader.getSkills();
      const items: SkillEntry[] = result.skills.map((skill) => ({
        name: skill.name, description: skill.description, path: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation, source: skill.sourceInfo.source,
      }));
      return inventoryOk(scope, "discovered", items, result.diagnostics.length > 0);
    },
    tools: () => {
      const active = new Set(session.getActiveToolNames());
      const items: ToolEntry[] = session.getAllTools().map((tool) => {
        const schema = asRecord(tool.parameters);
        return { name: tool.name, description: tool.description, active: active.has(tool.name),
          ...(schema === null ? {} : { inputSchema: schema }) };
      });
      return inventoryOk(scope, "registered", items);
    },
  };
}
function reader<T>(select: (readers: PiReaders) => () => InventoryResult<T>): InventoryReader<T> {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return unsupportedInventory("installation_unsupported", "Pi inventory requires the bundled SDK");
    }
    const scope = workspaceScope(options);
    // Cleanup stays inside the task: if the caller times out during SDK startup,
    // the eventual session is still disposed. No trust-store write or model prompt.
    const result = await inventoryRead(async () => {
      const sdk = await import("@earendil-works/pi-coding-agent");
      const agentDir = process.env.OAR_PI_AGENT_DIR ?? sdk.getAgentDir();
      const services = await sdk.createAgentSessionServices({ cwd: scope.cwd, agentDir });
      const { session } = await sdk.createAgentSessionFromServices({
        services, sessionManager: sdk.SessionManager.inMemory(scope.cwd),
      });
      try {
        return select(piInventories(session, scope))();
      } finally {
        session.dispose();
      }
    }, options.timeoutMs);
    return result;
  };
}
export const piSkills = reader((readers) => readers.skills);
export const piTools = reader((readers) => readers.tools);
