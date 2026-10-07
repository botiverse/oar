import type { SessionOptions } from "../../contracts/session.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { givenMcpServers } from "../../shared/mcp-servers.js";
import { handOverMcpConfig, sweepAbandonedMcpConfigs } from "./mcp-config.js";

/*
 * Starting the claude process for one session: SessionOptions as flags.
 *
 * SessionOptions.mcpServers is `--mcp-config <path>` (claude 2.1.292, probed
 * against a scripted provider), handed over as mcp-config.ts describes. The
 * servers join the user's own, which stay loaded because oar never passes
 * `--strict-mcp-config`; claude reports them in system/init as `source:
 * "dynamic"`, and a dynamic server replaces a user-scope server of the same
 * name for that process (the user's other servers stay). The same flag goes
 * on a `--resume`, which remembers none.
 */

/** The process a claude session drives. */
export type ClaudeProcess = LineProcess;

function spawnClaude(command: string, sessionId: string, options: SessionOptions, mcpConfig: string | null): LineProcess {
  return spawnLineProcess(command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--replay-user-messages",
    // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
    // no human at an approval prompt: a permission gate is a hang, not
    // safety. Isolation is the sandbox's job, not the approval flow's.
    "--dangerously-skip-permissions",
    ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
    ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
    ...(mcpConfig === null ? [] : ["--mcp-config", mcpConfig]),
  ], {
    cwd: options.cwd,
    env: { ...process.env, CLAUDECODE: undefined, ...options.env },
  });
}

/**
 * Start claude for a session (`--session-id`, or `--resume` an existing one)
 * and wait until it runs; with MCP servers, their config is handed over as
 * mcp-config.ts describes and gone at the latest when the process exits.
 * Rejects on a list with an empty or repeated name before anything starts,
 * and when claude cannot be spawned.
 */
export async function launchClaude(command: string, sessionId: string, options: SessionOptions): Promise<ClaudeProcess> {
  const servers = givenMcpServers(options.mcpServers);
  // Either way, what dead hosts left behind goes first (mcp-config.ts).
  const mcpConfig = servers === null ? null : await handOverMcpConfig(servers);
  if (mcpConfig === null) {
    await sweepAbandonedMcpConfigs();
  }
  let child: LineProcess | null = null;
  try {
    child = spawnClaude(command, sessionId, options, mcpConfig?.path ?? null);
  } finally {
    if (child === null) {
      mcpConfig?.end();
    }
  }
  if (mcpConfig !== null) {
    // Fires once, for an exit or a failed spawn alike, before `exited` resolves.
    child.onExit(() => {
      mcpConfig.end();
    });
    mcpConfig.start();
  }
  await child.spawned;
  return child;
}
