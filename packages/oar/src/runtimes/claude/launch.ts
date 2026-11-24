import { claudeRefusedSessionOptions } from "./options.js";
/* oxlint-disable import/max-dependencies -- Launch validates native options and owns MCP and prompt-file handoffs. */
import { claudeUserConfiguration } from "./user-configuration.js";
import { claudeServiceTierSettings } from "./service-tier.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionOptions } from "../../contracts/index.js";
import { claudePermissionArgs, claudeSettingsArgs, refuseForkLaunchArgs, refuseManagedLaunchArgs } from "./launch-args.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { givenMcpServers } from "../../shared/mcp-servers.js";
import { checkSessionName, refuseSessionOptions } from "../../shared/session-options.js";
import { handOverMcpConfig, sweepAbandonedMcpConfigs } from "./mcp-config.js";
import { claudePromptFiles } from "./prompt-files.js";

/*
 * Starting the claude process for one session: SessionOptions as flags.
 *
 * SessionOptions.mcpServers is `--mcp-config <path>` (claude 2.1.292, probed
 * against a scripted provider), handed over as mcp-config.ts describes. The
 * servers join the user's own by default. With userConfiguration: exclude,
 * `--strict-mcp-config` loads only the host's servers. Claude reports them as `source:
 * "dynamic"`, and a dynamic server replaces a user-scope server of the same
 * name for that process (the user's other servers stay). The same flag goes
 * on a `--resume`, which remembers none.
 */

/** The process a claude session drives. */
export type ClaudeProcess = LineProcess & {
  /** Non-FIFO fallback file only: true when `--mcp-config` is a regular file awaiting startup readback before deletion. */
  readonly mcpConfigFile?: boolean;
  /** Release a non-FIFO `--mcp-config` file once Claude has completed its startup handshake. */
  readonly releaseMcpConfig?: () => void;
};

/**
 * The session identity flags: a new session under OAR's id, a resume of
 * `options.resume`, or a fork of it (SessionOptions.fork). A fork is
 * `--resume <source> --fork-session --session-id <new>`, so the copy runs
 * under the id OAR assigned and `Session.id` reports, plus the hidden
 * `--resume-session-at <assistant message uuid>` to cut it after that
 * message ([env] claude 2.1.323: the copy holds the history through it,
 * the source transcript is unchanged, the copy resumes later under its id;
 * an unknown uuid ends startup with `No message found with message.uuid of:
 * <uuid>`). The anchor goes in `--flag=value` form, so one starting with
 * `-` is never read as a flag.
 */
export function claudeSessionArgs(sessionId: string, options: Pick<SessionOptions, "resume" | "fork">): readonly string[] {
  if (options.resume === undefined) { return [`--session-id=${sessionId}`]; }
  if (options.fork === undefined) { return [`--resume=${sessionId}`]; }
  const through = options.fork.through;
  return [`--resume=${options.resume}`, "--fork-session", `--session-id=${sessionId}`, ...(through === undefined ? [] : [`--resume-session-at=${through}`])];
}

function spawnClaude(command: string, sessionId: string, options: SessionOptions, mcpConfig: string | null, tierSettings: JsonRecord, nativeArgs: readonly string[], capture?: string): LineProcess {
  const directories = resolvedAdditionalDirectories(options);
  const configuration = claudeUserConfiguration(options);
  const settings = { ...tierSettings, ...configuration.settings };
  if (capture !== undefined) {
    settings.env = { ...asRecord(tierSettings.env), ...asRecord(configuration.settings.env), OTEL_LOG_RAW_API_BODIES: capture };
  }
  return spawnLineProcess(command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--replay-user-messages", "--include-partial-messages",
    ...claudeSessionArgs(sessionId, options),
    // SessionOptions.name (#368) names a new session only: `--name` on a
    // resume replaces the name the session has, which may be the user's
    // ([env] claude 2.1.292: it reports the old one as session_title_changed
    // at startup, and a new `--name` overwrites it). A fork is a new session.
    ...((options.resume !== undefined && options.fork === undefined) || options.name === undefined ? [] : ["--name", options.name]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ...claudeSettingsArgs(settings, options.launchArgs),
    ...nativeArgs,
    ...configuration.args,
    ...(options.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(options.outputSchema)]),
    // The host's flags, after managed/permission validation, ahead of
    // the variadic flags below so none swallows them as values.
    ...options.launchArgs ?? [],
    ...(directories.length === 0 ? [] : ["--add-dir", ...directories]),
    ...(mcpConfig === null ? [] : ["--mcp-config", mcpConfig]),
    ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--disallowed-tools", ...options.disallowedTools ?? []]),
  ], {
    cwd: options.cwd,
    // Without the parent session's markers, so print mode chooses sdk-cli and
    // claude is not a child of the host's own claude (environment.ts).
    env: configuration.env,
    // On Windows an npm .cmd wrapper can exit while native claude keeps
    // the provider request and stdio alive. Teardown must reach both.
    killTree: true,
  });
}

/**
 * Start claude for a session (`--session-id`, `--resume` an existing one, or
 * fork one under `sessionId`)
 * and wait until it runs; with MCP servers, their config is handed over as
 * mcp-config.ts describes and gone at the latest when the process exits.
 * Rejects on a list with an empty or repeated name, or `launchArgs` that
 * collide with a flag OAR manages (launch-args.ts), before anything starts,
 * and when claude cannot be spawned.
 */
export async function launchClaude(command: string, sessionId: string, options: SessionOptions, capture?: string): Promise<ClaudeProcess> {
  refuseManagedLaunchArgs(options.launchArgs);
  refuseForkLaunchArgs(options.launchArgs, options.fork);
  const permissions = claudePermissionArgs(options.launchArgs, options.questions);
  refuseSessionOptions(claudeRefusedSessionOptions, options);
  checkSessionName(options);
  const tierSettings = claudeServiceTierSettings(options.serviceTier);
  const servers = givenMcpServers(options.mcpServers);
  // Either way, what dead hosts left behind goes first (mcp-config.ts).
  const mcpConfig = servers === null ? null : await handOverMcpConfig(servers);
  if (mcpConfig === null) {
    await sweepAbandonedMcpConfigs();
  }
  let child: LineProcess | null = null;
  let prompts: Awaited<ReturnType<typeof claudePromptFiles>> = null;
  try {
    prompts = await claudePromptFiles(options);
    child = spawnClaude(command, sessionId, options, mcpConfig?.path ?? null, tierSettings, [...permissions, ...prompts?.args ?? []], capture);
    // Exit also covers a failed asynchronous spawn. Both cleanups are idempotent.
    child.onExit(() => {
      mcpConfig?.end();
      prompts?.remove();
    });
    mcpConfig?.start();
    await child.spawned;
    return Object.assign(child, mcpConfig?.kind === "file"
      ? { mcpConfigFile: true as const, releaseMcpConfig: () => { mcpConfig.releaseAfterRead(); } }
      : {});
  } catch (error) {
    child?.kill();
    mcpConfig?.end();
    prompts?.remove();
    throw error;
  }
}
