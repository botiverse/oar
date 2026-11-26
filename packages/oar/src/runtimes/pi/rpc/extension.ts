/** Pi loads this module with its own extension loader and SDK aliases.
 * Keep it as source so a single-file host can materialize it without its own
 * source tree. The native RPC tests execute this exact module.
 */
export const piRpcExtensionSource = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { CONFIG_DIR_NAME, createCodingTools, createMcpExtension, getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

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
    keys.unref();
  };
  keys.on("error", fail);
  acknowledgments.on("error", fail);
  acknowledgments.on("close", fail);
  acknowledgments.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiting.length === 0) { keys.unref(); }
    if (waiter !== undefined) { clearTimeout(waiter.timer); waiter.resolve(line); }
  });
  const exchange = (payload) => new Promise((resolve, reject) => {
    if (keys.destroyed) { reject(new Error("Pi RPC credential pipe is closed")); return; }
    keys.ref();
    const timer = setTimeout(() => { keys.destroy(); fail(); }, 30_000);
    waiting.push({ resolve, reject, timer });
    keys.write(JSON.stringify(payload) + "\n");
  });
  const config = JSON.parse(await exchange({ type: "config" }));
  // Match DefaultResourceLoader.discoverAppendSystemPromptFile in the selected Pi.
  // Pi loads CLI extensions before reading the prompt flags. Use the selected
  // CLI's own config directory and the trust choice passed to --[no-]approve.
  if (config.hasHostAppend) {
    const project = path.join(process.cwd(), CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
    const source = config.projectTrusted && existsSync(project) ? project : path.join(getAgentDir(), "APPEND_SYSTEM.md");
    const configured = existsSync(source) ? readFileSync(source, "utf8").replace(/^\uFEFF/u, "") : "";
    const host = readFileSync(path.join(directory, "append.txt"), "utf8");
    const effective = configured ? configured + "\n\n" + host : host;
    const file = path.join(directory, "effective-append.txt");
    writeFileSync(file, effective, { mode: 0o600 });
    if (readFileSync(file, "utf8") !== effective) { throw new Error("Could not retain the Pi RPC append instructions"); }
  }
  if (config.servers.length > 0) {
    await createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: path.join(config.agentDir, "mcp.log") })(pi);
    for (const server of config.servers) { pi.registerMcpServer(server.name, server.config); }
  }
  // SessionOptions.piProvider: a load-time registration is queued and applied
  // when Pi binds its model plane, before --model and the session's model
  // resolve. Nothing is written to models.json, and the credential is the
  // $NAME reference the host sent, which Pi resolves at request time.
  if (config.provider !== undefined) {
    if (typeof pi.registerProvider !== "function") { throw new Error("This Pi cannot register a provider from an extension, which SessionOptions.piProvider needs"); }
    pi.registerProvider(config.provider.id, config.provider.entry);
  }
  const remember = async (context) => {
    if (context.model === undefined) { return; }
    const auth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
    if (auth.ok && auth.apiKey !== undefined) {
      // Parent acknowledgment orders registration before provider output on
      // stdout. The key stays in this private pipe, never a file or RPC frame.
      await exchange(auth.apiKey);
    }
  };
  // The parent will not read an extension off disk: it learns what this session
  // loaded from this report, taken from the running session's own tool list.
  // Entries Pi does not describe are dropped rather than repaired.
  const reportTools = () => ({
    type: "tools",
    tools: pi.getAllTools().flatMap((tool) => {
      const info = tool.sourceInfo ?? {};
      return typeof tool.name === "string" && typeof info.path === "string" && typeof info.source === "string"
        ? [{ name: tool.name, path: info.path, source: info.source }]
        : [];
    }),
  });
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
    await exchange(reportTools());
    writeFileSync(path.join(directory, "ready"), JSON.stringify({
      version: VERSION,
      modelRegistered: context.model !== undefined && context.modelRegistry.find(context.model.provider, context.model.id) !== undefined,
      // What the model plane holds for a declared provider: the parent compares
      // this with the declaration and fails closed when it is short.
      provider: config.provider === undefined ? null : {
        id: config.provider.id,
        models: context.modelRegistry.getAll().filter((model) => model.provider === config.provider.id).length,
      },
    }), { mode: 0o600 });
  });
  // Extensions bind at session start, in load order, so this is the first
  // moment the tool list is complete: refresh it once per turn, before any tool
  // this turn could run.
  pi.on("before_agent_start", async () => { await exchange(reportTools()); });
  pi.on("model_select", async (_event, context) => { await remember(context); });
}
`;
