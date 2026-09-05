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
  // kimi-code f9ca33376 acp-server session.ts onTurnEnded: prompt answered
  // first, usage_update pushed afterwards from an un-awaited async task.
  usageUpdateAfterPrompt: true,
  configureSession: async ({ connection, sessionId, response, requestOptions }) => {
    if (supportsKimiYolo(response)) {
      await connection.agent.request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
        requestOptions,
      );
    }
  },
};

export const kimiSession = acpSession(kimiAcpProfile);
