import { claudeServiceTierArgs } from "./service-tier.js";
import { UnsupportedOptionError, type SessionOptions } from "../../contracts/index.js";
import { refuseManagedLaunchArgs } from "./launch-args.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { claudeSessionEnv } from "./environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { givenMcpServers } from "../../shared/mcp-servers.js";
import { checkSessionName } from "../../shared/session-options.js";
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

function spawnClaude(command: string, sessionId: string, options: SessionOptions, mcpConfig: string | null, tierArgs: readonly string[]): LineProcess {
  const directories = resolvedAdditionalDirectories(options);
  return spawnLineProcess(command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--replay-user-messages", "--include-partial-messages",
    // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
    // no human at an approval prompt: a permission gate is a hang, not
    // safety. Isolation is the sandbox's job, not the approval flow's.
    "--dangerously-skip-permissions",
    ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
    // SessionOptions.name (#368) names a new session only: `--name` on a
    // resume replaces the name the session has, which may be the user's
    // ([env] claude 2.1.292: it reports the old one as session_title_changed
    // at startup, and a new `--name` overwrites it).
    ...(options.resume !== undefined || options.name === undefined ? [] : ["--name", options.name]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ...tierArgs,
    ...(options.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(options.outputSchema)]),
    ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
    ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
    // The host's own flags, unchecked (SessionOptions.launchArgs), ahead of
    // the variadic flags below so none swallows them as values.
    ...options.launchArgs ?? [],
    ...(directories.length === 0 ? [] : ["--add-dir", ...directories]),
    ...(mcpConfig === null ? [] : ["--mcp-config", mcpConfig]),
    ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--disallowed-tools", ...options.disallowedTools ?? []]),
  ], {
    cwd: options.cwd,
    // Without the parent session's markers, so print mode chooses sdk-cli and
    // claude is not a child of the host's own claude (environment.ts).
    env: sessionEnvironment(claudeSessionEnv(options.env)),
    // On Windows an npm .cmd wrapper can exit while native claude keeps
    // the provider request and stdio alive. Teardown must reach both.
    killTree: true,
  });
}

/**
 * Start claude for a session (`--session-id`, or `--resume` an existing one)
 * and wait until it runs; with MCP servers, their config is handed over as
 * mcp-config.ts describes and gone at the latest when the process exits.
 * Rejects on a list with an empty or repeated name, or `launchArgs` that
 * collide with a flag OAR manages (launch-args.ts), before anything starts,
 * and when claude cannot be spawned.
 */
export async function launchClaude(command: string, sessionId: string, options: SessionOptions): Promise<ClaudeProcess> {
  if (options.resume !== undefined) {
    for (const option of ["systemPrompt", "appendSystemPrompt"] as const) {
      if (options[option] !== undefined) {
        throw new UnsupportedOptionError(option, `Claude ignores ${option} when resuming. Omit systemPrompt and appendSystemPrompt on resume to keep the saved prompts; create a new session to change them.`);
      }
    }
  }
  refuseManagedLaunchArgs(options.launchArgs);
  checkSessionName(options);
  const tierArgs = claudeServiceTierArgs(options.serviceTier);
  const servers = givenMcpServers(options.mcpServers);
  // Either way, what dead hosts left behind goes first (mcp-config.ts).
  const mcpConfig = servers === null ? null : await handOverMcpConfig(servers);
  if (mcpConfig === null) {
    await sweepAbandonedMcpConfigs();
  }
  let child: LineProcess | null = null;
  try {
    child = spawnClaude(command, sessionId, options, mcpConfig?.path ?? null, tierArgs);
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
