import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
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
  systemPrompt: "The Antigravity ACP server has no system prompt override in its protocol, launch options, or configuration",
  appendSystemPrompt: "The Antigravity ACP server has no system prompt append input in its protocol, launch options, or configuration",
};

export const antigravityAcpProfile: AcpSessionProfile = {
  args: () => antigravityAcpArgs(),
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
  },
  // `session/set_model` answers `{}` and no `config_option_update` is ever
  // pushed, so only `set_config_option` reports the switch. Effort is part
  // of the model id and no `thought_level` option exists.
  modelViaConfigOption: true,
  // A resumed session comes back in mode `default`, so yolo is applied on
  // every open, not only on `session/new`.
  configureSession: async ({ connection, sessionId, response, requestOptions }) => {
    if (supportsAntigravityYolo(response)) {
      await connection.agent.request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
        requestOptions,
      );
    }
  },
};

export const antigravitySession = acpSession(antigravityAcpProfile);
