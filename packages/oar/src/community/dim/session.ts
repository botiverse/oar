import type { StartSession } from "../../contracts/session.js";
import { acpErrorReason, type AcpFailureReader } from "../../shared/acp/failure.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { checkMcpServerNames } from "../../shared/mcp-servers.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { startDimDaemon } from "./daemon.js";
import { dimConfigureModel } from "./model.js";
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
  // Dim pushes every applied setting as config_option_update; right after a
  // model switch its effort answer still reports the previous level.
  confirmConfigOptionUpdates: true,
  configureModel: dimConfigureModel,
  configureSession: async ({ request, sessionId, response }) => {
    if (needsDimFullAccess(response)) {
      await request("session/set_mode", { sessionId, modeId: FULL_ACCESS });
    }
  },
};

const dimAcpSession = acpSession(dimAcpProfile);

/** Checks run before the App Server starts, so a refused open leaves no server behind. */
export const dimSession: StartSession = async (installation, options, context) => {
  dimAcpProfile.validateOptions?.(options);
  checkMcpServerNames(options.mcpServers ?? []);
  if (installation.via === "executable") {
    // `dima runtime list` gets the session's env; its stderr and the App Server log may echo a key.
    try { await startDimDaemon(installation.command, options); }
    catch (error) { throw sessionCredentialRedactor(options).redactValue(error); }
  }
  return dimAcpSession(installation, options, context);
};
