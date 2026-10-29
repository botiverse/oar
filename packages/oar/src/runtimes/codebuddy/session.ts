import type { SessionOptions, StartSession } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { codebuddyPromptFile } from "./prompt-file.js";
import { codebuddyPromptOutcome } from "./failure.js";
import { codebuddyNotifications } from "./extensions.js";
import { redactCodebuddyNotification } from "../../shared/credential-redaction.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { checkCodebuddyLaunchArgs, codebuddyRefusedSessionOptions } from "./options.js";

const args = (options: SessionOptions): readonly string[] => ["--acp", "--permission-mode", "bypassPermissions",
    ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--disallowedTools", options.disallowedTools?.join(",") ?? ""])];

export const codebuddyAcpProfile: AcpSessionProfile = {
  args,
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  modelViaConfigOption: true,
  promptOutcome: codebuddyPromptOutcome,
  extensionNotifications: codebuddyNotifications,
  redactExtensionNotification: redactCodebuddyNotification,
  validateOptions: (options) => {
    refuseSessionOptions(codebuddyRefusedSessionOptions, options);
    checkCodebuddyLaunchArgs(options.launchArgs);
    if (options.systemPrompt !== undefined && options.systemPrompt.trim() === "") {
      throw new UnsupportedOptionError("systemPrompt", "CodeBuddy treats an empty replacement as omitted");
    }
  },
};

export const codebuddySession: StartSession = async (installation, options) => {
  codebuddyAcpProfile.validateOptions?.(options);
  const file = options.systemPrompt === undefined ? undefined : await codebuddyPromptFile(options.systemPrompt);
  try {
    const session = await acpSession({ ...codebuddyAcpProfile, args: (input) => [...args(input), ...file?.args ?? []] })(installation, options);
    const unsubscribe = session.rawEvents((record) => {
      if (record.kind === "response" && record.body.kind === "exited") { file?.remove(); }
    });
    return { ...session, dispose: async () => {
      try { await session.dispose(); } finally { unsubscribe(); file?.remove(); }
    } };
  } catch (error) { file?.remove(); throw error; }
};
