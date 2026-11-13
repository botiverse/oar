import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { devinRefusedSessionOptions } from "./options.js";

/** Native Devin CLI ACP launch arguments. */
export const devinAcpArgs = (): readonly string[] => [
  "--permission-mode",
  "dangerous",
  "--respect-workspace-trust",
  "false",
  "acp",
];

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
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  validateOptions: (options) => {
    refuseSessionOptions(devinRefusedSessionOptions, options);
  },
  modelViaConfigOption: true,
  configureSession: async ({ request, sessionId, response }) => {
    if (supportsDevinBypass(response)) {
      await request("session/set_mode", { sessionId, modeId: "bypass" });
    }
  },
};

export const devinSession = acpSession(devinAcpProfile);
