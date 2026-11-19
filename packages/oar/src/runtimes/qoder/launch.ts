import type { OwnQueryProcess } from "../../shared/executable/query.js";
/* oxlint-disable import/max-dependencies -- Versioned native transport, private launch files and shared option validation. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionOptions } from "../../contracts/session.js";
import { rememberEnvironmentCredentials, type CredentialRedactor } from "../../shared/credential-redactor.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { readExecutableVersion, spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { privateTempDir } from "../../shared/private-temp.js";
import { checkMcpServerNames, givenMcpServers } from "../../shared/mcp-servers.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { qoderDaemonSession } from "./daemon.js";
import { handOverQoderMcpConfig, sweepAbandonedQoderMcpConfigs, type McpConfigHandoff } from "./mcp-config.js";
import { QODER_CREDENTIAL_ENV, qoderVersionInfo, qoderStartupError } from "./protocol.js";
import { checkQoderLaunchArgs, qoderRefusedSessionOptions } from "./options.js";

/** Process-scoped files and one-shot MCP handoffs keep credentials and system prompts out of argv. */
export async function launchQoder(command: string, sessionId: string, options: SessionOptions, version?: string, query?: { readonly signal: AbortSignal; readonly own: OwnQueryProcess }, credentials?: Pick<CredentialRedactor, "add" | "redact">): Promise<LineProcess & { readonly qoderVersion: string; releaseMcpConfig?(): void }> {
  refuseSessionOptions(qoderRefusedSessionOptions, options);
  checkQoderLaunchArgs(options.launchArgs);
  const env = { ...sessionEnvironment(options.env), QODER_EXPOSE_TOKEN_USAGE: "1" };
  if (credentials !== undefined) { rememberEnvironmentCredentials(credentials, env, QODER_CREDENTIAL_ENV); }
  checkMcpServerNames(options.mcpServers ?? []);
  const servers = givenMcpServers(options.mcpServers);
  const directories = resolvedAdditionalDirectories(options);
  const compatibility = qoderVersionInfo(version ?? await readExecutableVersion(command, 15_000, undefined, env, query?.signal));
  const { protocol } = compatibility;
  const needsPromptFiles = options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined;
  let mcpConfig: McpConfigHandoff | null = null;
  let temporary: Awaited<ReturnType<typeof privateTempDir>> | null = null;
  let child: LineProcess | undefined = undefined;
  try {
    mcpConfig = servers === null ? null : await handOverQoderMcpConfig(servers);
    if (mcpConfig === null) { await sweepAbandonedQoderMcpConfigs(); }
    temporary = needsPromptFiles ? await privateTempDir("oar-qoder-prompts-") : null;
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
    const args = [
      "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages",
      "--permission-mode", "bypass_permissions", "--permission-prompt-tool", "stdio",
      options.resume === undefined ? `--session-id=${sessionId}` : `--resume=${sessionId}`,
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--reasoning-effort", options.effort]),
      ...promptArgs,
      ...options.launchArgs ?? [],
      ...(mcpConfig === null ? [] : ["--mcp-config", mcpConfig.path]),
      ...(directories.length === 0 ? [] : ["--add-dir", ...directories]),
      ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--disallowed-tools", options.disallowedTools?.join(",") ?? ""]),
    ];
    query?.signal.throwIfAborted();
    child = spawnLineProcess(command, protocol === "daemon" ? ["--sdk"] : args, { cwd: options.cwd,
      env: protocol === "daemon" ? { ...env, QODER_AGENT_SDK_DAEMON: "1" } : env, killTree: true });
    query?.own(child);
    child.onExit(() => { mcpConfig?.end(); temporary?.remove(); });
    mcpConfig?.start();
    await child.spawned;
    const transport = protocol === "daemon" ? await qoderDaemonSession(child, sessionId, args, path.resolve(options.cwd), env, credentials) : child;
    return { ...transport, qoderVersion: compatibility.version, releaseMcpConfig: () => { mcpConfig?.releaseAfterRead(); } };
  } catch (error) { child?.kill(); mcpConfig?.end(); temporary?.remove(); throw qoderStartupError(error, options.effort); }
}

/** EOF finishes the native request before process-tree cleanup enforces the bound. */
export async function closeQoder(child: LineProcess): Promise<void> {
  const timer = setTimeout(() => { child.kill(); }, 5000);
  child.markNativeStop();
  child.stdin.end();
  try { await child.exited; } finally { clearTimeout(timer); }
}
