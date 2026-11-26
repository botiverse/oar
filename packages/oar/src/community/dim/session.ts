import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { StartSession } from "../../contracts/session.js";
import { acpErrorReason, type AcpFailureReader } from "../../shared/acp/failure.js";
import type { AcpModelConfiguration } from "../../shared/acp/model-configuration.js";
import { acpReportedModel } from "../../shared/acp/model.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { startDimDaemon } from "./daemon.js";
import { checkDimLaunchArgs, dimRefusedSessionOptions } from "./options.js";

const FULL_ACCESS = "full-access";

// Dim's own words for a turn its provider credential stopped (dimcode 0.1.0-alpha.29).
const MISSING_CREDENTIAL = "Missing credential environment variable: ";
const REJECTED_CREDENTIAL = "The provider rejected the credentials: ";

/** A credential failure, with whether the key was missing or refused; null leaves the rest to the generic rules. */
export const dimFailureOutcome: AcpFailureReader = (error) => {
  const reason = acpErrorReason(error);
  if (reason.startsWith(MISSING_CREDENTIAL)) { return { kind: "failed", reason, failure: "auth", credential: "missing" }; }
  if (reason.startsWith(REJECTED_CREDENTIAL)) { return { kind: "failed", reason, failure: "auth", credential: "rejected" }; }
  return null;
};

/** Whether the handshake offers `full-access` and the session is not already in it. */
export function needsDimFullAccess(response: JsonRecord): boolean {
  const modes = asRecord(response.modes);
  return modes?.currentModeId !== FULL_ACCESS && asRecordList(modes?.availableModes).some((mode) => mode.id === FULL_ACCESS);
}

/** Dim publishes a `model` option only for a model in its provider catalog (a `--model-config` file has none). */
export function hasDimModelOption(response: JsonRecord): boolean {
  return asRecordList(response.configOptions).some((option) => option.id === "model");
}

/**
 * `model` is the bare catalog id the `model` option lists; `effort` is its
 * `thought_level` option, which Dim publishes only for a model that declares
 * reasoning. The shared effort step refuses a session without one.
 */
export const dimConfigureModel: AcpModelConfiguration = async ({ options, response, setModel, setEffort }) => {
  const applied = options.model === undefined ? undefined : await applyDimModel(options.model, response, setModel);
  if (options.effort !== undefined) { await setEffort(options.effort, applied); }
  return applied;
};

async function applyDimModel(
  model: string,
  response: JsonRecord,
  setModel: (model: string) => Promise<JsonRecord | undefined>,
): Promise<JsonRecord | undefined> {
  if (!hasDimModelOption(response)) {
    throw new UnsupportedOptionError("model", "this Dim session advertises no model config option (a --model-config file is not a provider catalog)");
  }
  const applied = await setModel(model);
  const reported = acpReportedModel(applied ?? null);
  if (reported !== model) {
    throw new Error(`session/set_config_option left model at ${reported ?? "an unreported value"} although ${model} was requested`);
  }
  return applied;
}

export const dimAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  // `dima acp` serves the root line only, so subagent frames never reach this
  // transport; ACP has no steer, so the session has no `steer`. A prompt while
  // one runs is refused natively (`session_busy`), so OAR holds queued input.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  validateOptions: (options) => {
    refuseSessionOptions(dimRefusedSessionOptions, options);
    checkDimLaunchArgs(options.launchArgs);
  },
  // Dim checks the resume's cwd itself and refuses another one (`session_invalid_input`).
  isResumeNotFound: (native) => native.code === -32_002,
  // session/close closes the whole Dim Session and a later resume answers -32002.
  detachOnDispose: true,
  // Dim asks for the context usage once a turn ends and pushes it after the prompt's answer.
  usageUpdateAfterPrompt: true,
  failureOutcome: dimFailureOutcome,
  modelViaConfigOption: true,
  configureModel: dimConfigureModel,
  configureSession: async ({ request, sessionId, response }) => {
    if (needsDimFullAccess(response)) {
      await request("session/set_mode", { sessionId, modeId: FULL_ACCESS });
    }
  },
};

const dimAcpSession = acpSession(dimAcpProfile);

export const dimSession: StartSession = async (installation, options, context) => {
  dimAcpProfile.validateOptions?.(options);
  if (installation.via === "executable") { await startDimDaemon(installation.command, options); }
  return dimAcpSession(installation, options, context);
};
