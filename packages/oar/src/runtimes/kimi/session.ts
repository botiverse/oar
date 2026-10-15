import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { kimiRefusedSessionOptions } from "./options.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";

export function selectKimiAuthMethod(initialized: JsonRecord): string | undefined {
  const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  return methods
    .map((method) => asRecord(method))
    .some((method) => method?.id === "login")
    ? "login"
    : undefined;
}

export function supportsKimiYolo(response: JsonRecord): boolean {
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

export const kimiAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  // `kimi acp` binds the native session's `main` agent only (kimi-code
  // f9ca33376 acp-server session.ts), so children exist natively but never
  // reach this transport: opaque (tier #1), honestly root-only. The ACP
  // method set has no steer, so the profile has no `steerParams` and the
  // session no `steer`.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  selectAuthMethod: selectKimiAuthMethod,
  validateOptions: (options) => {
    refuseSessionOptions(kimiRefusedSessionOptions, options);
    if (options.resume !== undefined && (options.additionalDirectories?.length ?? 0) > 0) {
      throw new UnsupportedOptionError("additionalDirectories", "kimi applies additionalDirectories only when creating a session; they have no effect on resume");
    }
  },
  // kimi-code f9ca33376 acp-server session.ts onTurnEnded: prompt answered
  // first, usage_update pushed afterwards from an un-awaited async task.
  usageUpdateAfterPrompt: true,
  // A resume naming another directory ran in the session's own (2.1.1, probed
  // 2026-10-03), so a resume elsewhere is refused (profile.ts).
  resumeKeepsSessionCwd: true,
  // These runtimes lack a unique native missing-session code (#294).
  isResumeNotFound: (_native, listed) => listed === false,
  configureSession: async ({ request, sessionId, response }) => {
    if (supportsKimiYolo(response)) {
      await request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
      );
    }
  },
};

export const kimiSession = acpSession(kimiAcpProfile);
