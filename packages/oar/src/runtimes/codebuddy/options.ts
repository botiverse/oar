import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";

export const codebuddyRefusedSessionOptions: RefusedSessionOptions = {
  goals: "CodeBuddy ACP has no verified structured goal controls",
  appendSystemPrompt: "CodeBuddy ACP prompt append has no verified private input channel",
  userConfiguration: "CodeBuddy has no verified way to exclude user configuration while preserving native credentials and history",
  outputSchema: "CodeBuddy ACP has no verified final-output schema channel",
  name: "CodeBuddy has no verified session name option",
  serviceTier: "CodeBuddy ACP has no verified service-tier setting and readback",
  additionalDirectories: "CodeBuddy ACP does not advertise additionalDirectories",
};

export function checkCodebuddyLaunchArgs(args: SessionOptions["launchArgs"]): void {
  const managed = new Set(["--acp", "--acp-transport", "--serve", "--print", "-p", "--input-format", "--output-format",
    "--resume", "-r", "--continue", "-c", "--session-id", "--fork-session", "--permission-mode", "--permission-mode-before-plan", "--system-prompt", "--system-prompt-file", "--"]);
  for (const arg of args ?? []) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (managed.has(flag)) { throw new UnsupportedOptionError("launchArgs", `CodeBuddy launchArgs cannot override ${flag}; OAR owns the protocol and session identity`); }
  }
}
