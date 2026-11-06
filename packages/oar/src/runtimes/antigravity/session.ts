import type { SessionOptions } from "../../contracts/session.js";
import { antigravityRefusedSessionOptions } from "./options.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { rpcErrorCode } from "../../shared/acp/failure.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";

/** Native CLI ACP; a per-session worker is the vendor's required channel for HTTP MCP. */
export function antigravityAcpArgs(): readonly string[] {
  return ["acp", "--dangerously-skip-permissions", "--process-per-session"];
}

/** Native CLI 1.5.0 declares append metadata, but no tool-denial channel. */
function sessionMeta(options: SessionOptions, initialized: JsonRecord): JsonRecord | undefined {
  const { appendSystemPrompt } = options;
  const capabilities = asRecord(initialized.agentCapabilities);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP metadata envelope.
  const native = asRecord(asRecord(capabilities?._meta)?.antigravity);
  if (appendSystemPrompt !== undefined && asRecord(native?.systemPrompt)?.append !== true) {
    throw new UnsupportedOptionError("appendSystemPrompt", "antigravity does not advertise systemPrompt.append");
  }
  if (appendSystemPrompt === undefined) {
    return undefined;
  }
  return { antigravity: { systemPrompt: { append: appendSystemPrompt } } };
}

export const antigravityAcpProfile: AcpSessionProfile = {
  args: () => antigravityAcpArgs(),
  resumeKeepsSessionCwd: true,
  // Subagent transport attribution remains unverified. A second native
  // prompt steers the same loop and settles the preceding prompt early.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  steerParams: () => ({}),
  steerSupersedesPrompt: true,
  steerOutcomeIsLatest: true,
  // Native invalid image prompts return invalid-params without entering the loop.
  isSteerRefusal: (error) => rpcErrorCode(error) === -32_602,
  requestTimeoutMs: 30_000,
  // Native CLI configuration and cached authentication select the provider.
  validateOptions: (options) => {
    refuseSessionOptions(antigravityRefusedSessionOptions, options);
  },
  sessionMeta,
  // Only the config response confirms the selected family and thought level.
  modelViaConfigOption: true,
  confirmConfigOptionUpdates: true,
};

export const antigravitySession = acpSession(antigravityAcpProfile);
