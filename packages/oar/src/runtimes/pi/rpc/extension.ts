import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCodingTools, createMcpExtension, SettingsManager, type ExtensionAPI, type ExtensionContext, type McpServerConfig } from "@earendil-works/pi-coding-agent";

/** Loaded by Pi's own -e mechanism. No session or event loop is hosted here. */
export default async function oarPiRpcExtension(pi: ExtensionAPI): Promise<void> {
  const directory = process.env.OAR_PI_RPC_DIRECTORY;
  if (directory === undefined) { throw new Error("Missing OAR Pi RPC session configuration"); }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- The parent writes this closed shape before starting this child.
  const config: {
    agentDir: string;
    resume: boolean;
    servers: readonly { name: string; config: McpServerConfig }[];
  } = JSON.parse(readFileSync(path.join(directory, "config.json"), "utf8"));
  if (config.servers.length > 0) {
    await createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: path.join(config.agentDir, "mcp.log") })(pi);
    for (const server of config.servers) { pi.registerMcpServer(server.name, server.config); }
  }
  const remember = async (context: ExtensionContext): Promise<void> => {
    if (context.model === undefined) { return; }
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Pi types ExtensionContext.model with Model<any>; its registry owns that exact model.
    const auth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
    if (auth.ok && auth.apiKey !== undefined) {
      // A private side channel gives the parent its redaction material before
      // any provider response. Keys never enter RPC stdout or session records.
      appendFileSync(path.join(directory, "keys.jsonl"), `${JSON.stringify(auth.apiKey)}\n`, { mode: 0o600 });
    }
  };
  pi.on("session_start", async (_event, context) => {
    if (config.resume) {
      // -e loads this extension before user extensions. Reset only native
      // builtins; user session_start handlers still choose their own loadout.
      const tools = pi.getAllTools();
      const builtinNames = new Set(tools.filter((tool) => tool.sourceInfo.path === `builtin:${tool.name}`).map((tool) => tool.name));
      const defaults = SettingsManager.inMemory(pi.getSettings()).getDefaultTools() ?? createCodingTools(context.cwd).map((tool) => tool.name);
      pi.setActiveTools([...pi.getActiveTools().filter((name) => !builtinNames.has(name)), ...defaults.filter((name) => builtinNames.has(name))]);
    }
    await remember(context);
    writeFileSync(path.join(directory, "ready"), JSON.stringify({
      // oxlint-disable-next-line unicorn/no-array-method-this-argument, unicorn/prefer-array-some -- ModelRegistry.find(provider, id) is not Array.find.
      modelRegistered: context.model !== undefined && context.modelRegistry.find(context.model.provider, context.model.id) !== undefined,
    }), { mode: 0o600 });
  });
  pi.on("model_select", async (_event, context) => { await remember(context); });
}
