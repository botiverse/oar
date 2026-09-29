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

/** The permission modes a `session/new` (or resume) answer offers, and the one in effect: its `modes`, else its `mode` config option. */
function kimiModes(response: JsonRecord): { readonly available: readonly string[]; readonly current: string | null } {
  const modes = asRecord(response.modes);
  const availableModes = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  if (availableModes.length > 0) {
    return {
      available: availableModes.map((mode) => asRecord(mode)?.id).filter((id): id is string => typeof id === "string"),
      current: typeof modes?.currentModeId === "string" ? modes.currentModeId : null,
    };
  }
  const options = Array.isArray(response.configOptions) ? response.configOptions : [];
  const mode = options.map((option) => asRecord(option)).find((option) => option?.id === "mode");
  const values = Array.isArray(mode?.options) ? mode.options : [];
  return {
    available: values.map((value) => asRecord(value)?.value).filter((value): value is string => typeof value === "string"),
    current: typeof mode?.currentValue === "string" ? mode.currentValue : null,
  };
}

export function supportsKimiYolo(response: JsonRecord): boolean {
  return kimiModes(response).available.includes("yolo");
}

/**
 * The mode `SessionOptions.approvals` asks for: `yolo` ("Auto-approve
 * everything") by default, `default` ("Manual approvals; tools execute
 * normally", kimi 2.0.0's own default) for "ask", set whenever the session
 * answered another (a user's config can default to yolo). Null: nothing to
 * set.
 */
export function kimiModeFor(options: SessionOptions, response: JsonRecord): string | null {
  const { available, current } = kimiModes(response);
  const wanted = options.approvals === "ask" ? "default" : "yolo";
  if (!available.includes(wanted)) {
    if (options.approvals === "ask") {
      throw new Error(`kimi offers no "default" permission mode (modes: ${available.join(", ") || "none"}), so approvals "ask" cannot turn its gate on`);
    }
    return null;
  }
  return options.approvals === "ask" && current === wanted ? null : wanted;
}

function validateKimiOptions(options: SessionOptions): void {
  if (options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined) {
    throw new Error("Kimi ACP does not expose a system prompt override");
  }
}

export const kimiAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  // `kimi acp` binds the native session's `main` agent only (kimi-code
  // f9ca33376 acp-server session.ts), so children exist natively but never
  // reach this transport: opaque (tier #1), honestly root-only. The ACP
  // method set has no steer. Its permission modes (default / plan / auto /
  // yolo) gate tools through session/request_permission.
  capabilities: { steer: false, queue: { durable: false }, attribution: "opaque", approvals: { kind: "supported" } },
  // kimi 2.0.0 offers `approve_always` as "Approve for this session" (live 2026-09-29).
  allowAlwaysIsSession: true,
  requestTimeoutMs: 30_000,
  selectAuthMethod: selectKimiAuthMethod,
  validateOptions: validateKimiOptions,
  // kimi-code f9ca33376 acp-server session.ts onTurnEnded: prompt answered
  // first, usage_update pushed afterwards from an un-awaited async task.
  usageUpdateAfterPrompt: true,
  configureSession: async ({ connection, sessionId, response, options, requestOptions }) => {
    const modeId = kimiModeFor(options, response);
    if (modeId !== null) {
      await connection.agent.request("session/set_mode", { sessionId, modeId }, requestOptions);
    }
  },
};

export const kimiSession = acpSession(kimiAcpProfile);
