/* oxlint-disable import/max-dependencies -- The ACP profile composes Antigravity launch, configuration, token and outcome readers. */
import { antigravityQuotaError, antigravityQuotaNotice } from "./quota.js";
import { wholePromptTokenUsage } from "../../shared/acp/token-usage.js";
import { configureAntigravityModel } from "./model-selection.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { antigravityStateArgs } from "./state-directory.js";
import type { SessionOptions } from "../../contracts/session.js";
import { antigravityRefusedSessionOptions } from "./options.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { rpcErrorCode } from "../../shared/acp/failure.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";

/** Native CLI ACP; a per-session worker is the vendor's required channel for HTTP MCP. */
export function antigravityAcpArgs(env: Readonly<NodeJS.ProcessEnv> = process.env): readonly string[] {
  return ["acp", "--dangerously-skip-permissions", "--process-per-session", ...antigravityStateArgs(env)];
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
  args: (options) => antigravityAcpArgs(sessionEnvironment(options.env)),
  resumeKeepsSessionCwd: true,
  // Subagent transport attribution remains unverified. A second native
  // prompt steers the same loop and settles the preceding prompt early.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  steerParams: () => ({}),
  steerSupersedesPrompt: true,
  promptTokenUsage: wholePromptTokenUsage,
  promptOutcome: antigravityQuotaNotice,
  failureOutcome: (error, _frames, receivedAt) => antigravityQuotaError(error, receivedAt),
  steerOutcomeIsLatest: true,
  // Native invalid image prompts return invalid-params without entering the loop.
  isSteerRefusal: (error) => rpcErrorCode(error) === -32_602,
  requestTimeoutMs: 30_000,
  // OAR's conservative bound: the largest measured input whose two code
  // words both came back on agy 1.5.6; a 200,000-byte one lost its end word
  // (2026-11-12, experiments/antigravity-input-size-2026-11-12).
  maxInputBytes: 185_000,
  // Native CLI configuration and cached authentication select the provider.
  validateOptions: (options) => {
    refuseSessionOptions(antigravityRefusedSessionOptions, options);
  },
  sessionMeta,
  // Only the config response confirms the selected family and thought level.
  modelViaConfigOption: true,
  configureModel: configureAntigravityModel,
  confirmConfigOptionUpdates: true,
};

export const antigravitySession = acpSession(antigravityAcpProfile);
