/** Pi loads this module with its own extension loader and SDK aliases.
 * Keep it as source so a single-file host can materialize it without its own
 * source tree. The native RPC tests execute this exact module.
 */
export const piRpcExtensionSource = String.raw`import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { createCodingTools, createMcpExtension, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

export default async function oarPiRpcExtension(pi) {
  const directory = process.env.OAR_PI_RPC_DIRECTORY;
  if (directory === undefined) { throw new Error("Missing OAR Pi RPC session configuration"); }
  const keys = new Socket({ fd: 3, readable: true, writable: true });
  keys.unref();
  const acknowledgments = createInterface({ input: keys, crlfDelay: Infinity });
  const waiting = [];
  const fail = () => {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pi RPC credential pipe closed before acknowledgment"));
    }
  };
  keys.on("error", fail);
  acknowledgments.on("error", fail);
  acknowledgments.on("close", fail);
  acknowledgments.on("line", () => {
    const waiter = waiting.shift();
    if (waiter !== undefined) { clearTimeout(waiter.timer); waiter.resolve(); }
  });
  const config = JSON.parse(readFileSync(path.join(directory, "config.json"), "utf8"));
  if (config.servers.length > 0) {
    await createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: path.join(config.agentDir, "mcp.log") })(pi);
    for (const server of config.servers) { pi.registerMcpServer(server.name, server.config); }
  }
  const remember = async (context) => {
    if (context.model === undefined) { return; }
    const auth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
    if (auth.ok && auth.apiKey !== undefined) {
      // Parent acknowledgment orders registration before provider output on
      // stdout. The key stays in this private pipe, never a file or RPC frame.
      await new Promise((resolve, reject) => {
        if (keys.destroyed) { reject(new Error("Pi RPC credential pipe is closed")); return; }
        const timer = setTimeout(() => { keys.destroy(); fail(); }, 30_000);
        waiting.push({ resolve, reject, timer });
        keys.write(JSON.stringify(auth.apiKey) + "\n");
      });
    }
  };
  pi.on("session_start", async (_event, context) => {
    if (config.resume) {
      // -e loads this extension before user extensions. Reset only native
      // builtins; user session_start handlers still choose their own loadout.
      const tools = pi.getAllTools();
      const builtinNames = new Set(tools.filter((tool) => tool.sourceInfo.path === ("builtin:" + tool.name)).map((tool) => tool.name));
      const defaults = SettingsManager.inMemory(pi.getSettings()).getDefaultTools() ?? createCodingTools(context.cwd).map((tool) => tool.name);
      pi.setActiveTools([...pi.getActiveTools().filter((name) => !builtinNames.has(name)), ...defaults.filter((name) => builtinNames.has(name))]);
    }
    await remember(context);
    writeFileSync(path.join(directory, "ready"), JSON.stringify({
      version: VERSION,
      modelRegistered: context.model !== undefined && context.modelRegistry.find(context.model.provider, context.model.id) !== undefined,
    }), { mode: 0o600 });
  });
  pi.on("model_select", async (_event, context) => { await remember(context); });
}
`;
