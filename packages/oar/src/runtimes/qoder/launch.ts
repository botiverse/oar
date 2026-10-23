import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { privateTempDir } from "../../shared/private-temp.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { checkQoderLaunchArgs, qoderRefusedSessionOptions } from "./options.js";

/** Process-scoped files keep MCP credentials and system prompts out of argv. */
export async function launchQoder(command: string, sessionId: string, options: SessionOptions): Promise<LineProcess> {
  refuseSessionOptions(qoderRefusedSessionOptions, options);
  checkQoderLaunchArgs(options.launchArgs);
  const servers = options.mcpServers ?? [];
  checkMcpServerNames(servers);
  const directories = resolvedAdditionalDirectories(options);
  const needsFiles = servers.length > 0 || options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined;
  const temporary = needsFiles ? await privateTempDir("oar-qoder-mcp-") : null;
  let child: LineProcess | undefined = undefined;
  try {
    const config = temporary === null || servers.length === 0 ? null : path.join(temporary.path, "mcp.json");
    if (config !== null) {
      const entries = servers.map((server) => [server.name,
        isHttpMcpServer(server) ? { type: "http", url: server.url, headers: server.headers }
          : { type: "stdio", command: server.command, args: server.args ?? [], env: server.env }] as const);
      const mcpServers = Object.fromEntries(entries);
      await writeFile(config, JSON.stringify({ mcpServers }), { mode: 0o600, flag: "wx" });
    }
    const promptArgs: string[] = [];
    if (temporary !== null) {
      for (const [flag, name, text] of [
        ["--system-prompt-file", "system.txt", options.systemPrompt],
        ["--append-system-prompt-file", "append.txt", options.appendSystemPrompt],
      ] as const) {
        if (text === undefined) { continue; }
        const file = path.join(temporary.path, name);
        await writeFile(file, text, { mode: 0o600, flag: "wx" });
        promptArgs.push(flag, file);
      }
    }
    child = spawnLineProcess(command, [
      "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages",
      "--permission-mode", "bypass_permissions", "--permission-prompt-tool", "stdio",
      ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--reasoning-effort", options.effort]),
      ...promptArgs,
      ...options.launchArgs ?? [],
      ...(config === null ? [] : ["--mcp-config", config]),
      ...(directories.length === 0 ? [] : ["--add-dir", ...directories]),
      ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--disallowed-tools", options.disallowedTools?.join(",") ?? ""]),
    ], { cwd: options.cwd, env: { ...sessionEnvironment(options.env), QODER_EXPOSE_TOKEN_USAGE: "1" }, killTree: true });
    child.onExit(() => { temporary?.remove(); });
    await child.spawned;
    return child;
  } catch (error) { child?.kill(); temporary?.remove(); throw error; }
}

/** EOF finishes the native request before process-tree cleanup enforces the bound. */
export async function closeQoder(child: LineProcess): Promise<void> {
  const timer = setTimeout(() => { child.kill(); }, 5000);
  child.stdin.end();
  try { await child.exited; } finally { clearTimeout(timer); }
}
