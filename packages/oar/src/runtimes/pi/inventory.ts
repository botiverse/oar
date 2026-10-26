/* oxlint-disable oxc/no-map-spread -- Project immutable native entries into credential-free records. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CommandEntry, RuntimeInventories, InventoryReader, InventoryScope, InventoryResult, SkillEntry, ToolEntry } from "../../contracts/inventory.js";
import { asRecord } from "../../shared/json.js";
import { inventoryOk, inventoryRead, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { piAgentDir } from "./resolve.js";
import { checkPiProjectPackages, reportMissingPiPackages } from "./project.js";
import type { PiProjectOptions } from "./options.js";
import { initPiTheme } from "./theme.js";
import { piEnvBashTool } from "./open.js";

interface PiReaders {
  readonly skills: () => InventoryResult<SkillEntry>;
  readonly commands: () => InventoryResult<CommandEntry>;
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
    commands: () => {
      const runner = session.extensionRunner;
      const result = session.resourceLoader.getPrompts();
      const items: CommandEntry[] = [
        ...runner.getRegisteredCommands().map((command) => ({
          name: command.invocationName, source: "extension",
          ...(command.description === undefined ? {} : { description: command.description }),
        })),
        ...result.prompts.map((template) => ({
          name: template.name, description: template.description, source: "prompt",
          ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
        })),
      ];
      const partial = result.diagnostics.length > 0 || session.resourceLoader.getExtensions().errors.length > 0
        || runner.getCommandDiagnostics().length > 0;
      return inventoryOk(scope, "discovered", items, partial);
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
function reader<T>(select: (readers: PiReaders) => () => InventoryResult<T>, project: PiProjectOptions): InventoryReader<T> {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return unsupportedInventory("installation_unsupported", "Pi inventory requires the bundled SDK");
    }
    const scope = workspaceScope(options);
    // Cleanup stays inside the task: if the caller times out during SDK startup,
    // the eventual session is still disposed. No trust-store write or model prompt.
    const result = await inventoryRead(async () => {
      const sdk = await import("@earendil-works/pi-coding-agent");
      const agentDir = piAgentDir(() => sdk.getAgentDir());
      const settingsManager = sdk.SettingsManager.create(scope.cwd, agentDir, { projectTrusted: project.projectTrusted ?? true });
      await checkPiProjectPackages(scope.cwd, agentDir, settingsManager, project);
      await reportMissingPiPackages(scope.cwd, agentDir, settingsManager);
      initPiTheme(sdk.initTheme, settingsManager);
      const services = await sdk.createAgentSessionServices({ cwd: scope.cwd, agentDir, settingsManager });
      const { session } = await sdk.createAgentSessionFromServices({
        services, sessionManager: sdk.SessionManager.inMemory(scope.cwd),
        ...(options.env === undefined ? {} : { customTools: [await piEnvBashTool(scope.cwd, options.env)] }),
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
export function createPiInventories(project: PiProjectOptions = {}): Pick<RuntimeInventories, "skills" | "commands" | "tools"> {
  return { skills: reader((readers) => readers.skills, project),
    commands: reader((readers) => readers.commands, project),
    tools: reader((readers) => readers.tools, project) };
}
const defaults = createPiInventories();
export const piSkills = defaults.skills;
export const piCommands = defaults.commands;
export const piTools = defaults.tools;
