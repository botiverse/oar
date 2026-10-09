import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { hasMcpCredentials } from "../../shared/mcp-servers.js";
import { refuseSessionOptions } from "../../shared/session-options.js";

/**
 * The ACP registry's launch line for agy_acp_server 1.2.1. On Linux the
 * binary's startup drops privileges to group `nobody` unless `--uid=` is
 * empty, and on a host without that group it aborts before speaking ACP
 * ("Check failed: LookupGIDByGroupName"). macOS and Windows take no args.
 */
export function antigravityAcpArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "linux" ? ["--uid="] : [];
}

/**
 * agy_acp_server 1.2.1 lists `yolo` both as a session mode and as a value of
 * its `mode` config option; either way `session/set_mode` applies it.
 */
export function supportsAntigravityYolo(response: JsonRecord): boolean {
  const modes = asRecord(response.modes);
  const availableModes = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  if (availableModes.map((mode) => asRecord(mode)).some((mode) => mode?.id === "yolo")) {
    return true;
  }
  const options = Array.isArray(response.configOptions) ? response.configOptions : [];
  const mode = options.map((option) => asRecord(option)).find((option) => option?.id === "mode");
  const values = Array.isArray(mode?.options) ? mode.options : [];
  return values.map((value) => asRecord(value)).some((option) => option?.value === "yolo");
}

export const antigravityRefusedSessionOptions: RefusedSessionOptions = {
  serviceTier: "antigravity exposes no verified per-session service-tier setting and readback",
  systemPrompt: "The Antigravity ACP server has no system prompt override in its protocol, launch options, or configuration",
  appendSystemPrompt: "The Antigravity ACP server has no system prompt append input in its protocol, launch options, or configuration",
};

/**
 * SessionOptions.mcpServers entries antigravity can take: none carrying a
 * credential. agy_acp_server 1.3.0 writes a session's `mcpServers`, `env`
 * and `headers` values included, in plain text into its conversation
 * database (`$GEMINI_HOME/antigravity-acp/conversations/<id>.db`, 0600),
 * which outlives the session and which a host cannot see or clear through
 * ACP; credentials reach a runtime only through its native channel, never
 * its disk. An entry without `env` or `headers` attaches as usual.
 */
export function refuseAntigravityMcpCredentials(options: SessionOptions): void {
  const carrying = (options.mcpServers ?? []).find((server) => hasMcpCredentials(server));
  if (carrying !== undefined) {
    throw new UnsupportedOptionError("mcpServers", `antigravity stores a session's MCP servers, env and header values included, in plain text in its conversation database, where they outlive the session; it attaches no entry with env or headers (${JSON.stringify(carrying.name)})`);
  }
}

/** Canonical BuiltinTools values in agy_acp_server 1.3.0's distributed types.py.
 * Native tool_filter.py logs and ignores other names, so fail before launch.
 * The names are a validation set, never an allowlist sent to the runtime. */
const ANTIGRAVITY_FILTER_NAMES = new Set([
  "list_directory", "search_directory", "find_file", "view_file", "create_file", "edit_file",
  "run_command", "ask_question", "start_subagent", "generate_image", "search_web", "read_url_content", "schedule", "finish",
]);

export function antigravityToolDenials(options: SessionOptions): void {
  const unsupported = (options.disallowedTools ?? []).filter((name) => !ANTIGRAVITY_FILTER_NAMES.has(name));
  if (unsupported.length > 0) {
    throw new UnsupportedOptionError("disallowedTools", `antigravity disabledTools only filters canonical built-in names; MCP, client tools and unknown names cannot be disabled: ${JSON.stringify(unsupported)}`);
  }
}

export const antigravityAcpProfile: AcpSessionProfile = {
  args: () => antigravityAcpArgs(),
  isResumeNotFound: (native) => native.code === -32_002,
  // Subagents run inside the harness and never reach ACP under their own
  // ids: opaque (tier #1, docs/spec/attribution.md). The method set has no
  // steer, so the profile has no `steerParams` and the session no `steer`.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  // Startup unpacks a large Python archive; the first initialize can take
  // several seconds on a cold disk.
  requestTimeoutMs: 30_000,
  // No `authenticate`: the server signs in from the `auth.type` its own
  // login persisted plus the cached token, or from GEMINI_API_KEY.
  validateOptions: (options) => {
    refuseSessionOptions(antigravityRefusedSessionOptions, options);
    refuseAntigravityMcpCredentials(options);
    antigravityToolDenials(options);
  },
  sessionMeta: (options) => options.disallowedTools === undefined ? undefined : { agy: { disabledTools: [...options.disallowedTools] } },
  // `session/set_model` answers `{}` and no `config_option_update` is ever
  // pushed, so only `set_config_option` reports the switch. Effort is part
  // of the model id and no `thought_level` option exists.
  modelViaConfigOption: true,
  // A resumed session comes back in mode `default`, so yolo is applied on
  // every open, not only on `session/new`.
  configureSession: async ({ request, sessionId, response }) => {
    if (supportsAntigravityYolo(response)) {
      await request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
      );
    }
  },
};

export const antigravitySession = acpSession(antigravityAcpProfile);
