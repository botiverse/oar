import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import { acpErrorReason, rpcErrorCode, type AcpFailureReader, type AcpOpenFailureReader } from "../../shared/acp/failure.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { devinRefusedSessionOptions } from "./options.js";

const DEVIN_AUTH_ERROR = /authentication required|invalid api key|not logged in/iu;

function isDevinAuthRpcError(error: unknown): error is Error {
  return error instanceof Error && rpcErrorCode(error) !== null && DEVIN_AUTH_ERROR.test(error.message);
}

/** Map Devin JSON-RPC sign-in failures during open or model selection to `RuntimeFailureError("auth")`. */
export const devinOpenFailure: AcpOpenFailureReader = (error) =>
  isDevinAuthRpcError(error)
    ? new RuntimeFailureError("auth", error.message, { cause: error.cause ?? error })
    : null;

/** Map Devin JSON-RPC sign-in failures on `session/prompt` to `failure: "auth"`. */
export const devinFailureOutcome: AcpFailureReader = (error) =>
  isDevinAuthRpcError(error)
    ? { kind: "failed", reason: acpErrorReason(error), failure: "auth" }
    : null;

/** Native Devin CLI ACP launch arguments. */
export const devinAcpArgs = (): readonly string[] => ["acp"];

/** Whether the session handshake advertises the `bypass` permission mode. */
export function supportsDevinBypass(response: JsonRecord): boolean {
  const modes = asRecord(response.modes);
  const availableModes = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  if (availableModes.map((mode) => asRecord(mode)).some((mode) => mode?.id === "bypass")) {
    return true;
  }
  const options = Array.isArray(response.configOptions) ? response.configOptions : [];
  const mode = options.map((option) => asRecord(option)).find((option) => option?.id === "mode");
  const values = Array.isArray(mode?.options) ? mode.options : [];
  return values.map((value) => asRecord(value)).some((option) => option?.value === "bypass");
}

export const devinAcpProfile: AcpSessionProfile = {
  args: () => devinAcpArgs(),
  resumeKeepsSessionCwd: true,
  isResumeNotFound: (native) =>
    native.code === -32_016 && asRecord(native.data)?.["cognition.ai/errorKind"] === "session_not_found",
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  validateOptions: (options) => {
    refuseSessionOptions(devinRefusedSessionOptions, options);
  },
  modelViaConfigOption: true,
  openFailure: devinOpenFailure,
  failureOutcome: devinFailureOutcome,
  configureSession: async ({ request, sessionId, response }) => {
    if (supportsDevinBypass(response)) {
      await request("session/set_mode", { sessionId, modeId: "bypass" });
    }
  },
};

export const devinSession = acpSession(devinAcpProfile);
