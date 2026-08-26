import type { SessionOptions } from "../../contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

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

function validateKimiOptions(options: SessionOptions): void {
  if (options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined) {
    throw new Error("Kimi ACP does not expose a system prompt override");
  }
}

export const kimiAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  requestTimeoutMs: 30_000,
  selectAuthMethod: selectKimiAuthMethod,
  validateOptions: validateKimiOptions,
  configureSession: async ({ client, sessionId, response }) => {
    if (supportsKimiYolo(response)) {
      await client.request("session/set_mode", { sessionId, modeId: "yolo" });
    }
  },
};

export const kimiSession = acpSession(kimiAcpProfile);
