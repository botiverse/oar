import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { checkManagedLaunchArgs } from "../../shared/launch-args.js";
import { dshOnlyRefusals, piOnlyRefusals } from "../../shared/session-options.js";

export const codebuddyRefusedSessionOptions: RefusedSessionOptions = {
  ...piOnlyRefusals,
  ...dshOnlyRefusals,
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native CodeBuddy fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "CodeBuddy ACP has no verified structured goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted CodeBuddy turn's processes while its session stays usable",
  appendSystemPrompt: "CodeBuddy ACP prompt append has no verified private input channel",
  userConfiguration: "CodeBuddy has no verified way to exclude user configuration while preserving native credentials and history",
  outputSchema: "CodeBuddy ACP has no verified final-output schema channel",
  name: "CodeBuddy has no verified session name option",
  serviceTier: "CodeBuddy ACP has no verified service-tier setting and readback",
  additionalDirectories: "CodeBuddy ACP does not advertise additionalDirectories",
  nativeMemoryDefault: "CodeBuddy has no verified settings layer below user configuration for autoMemoryEnabled",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

const CODEBUDDY_MANAGED_LAUNCH_ARGS = new Set([
  "--acp", "--acp-transport", "--serve", "--print", "-p", "--input-format", "--output-format",
  "--resume", "-r", "--continue", "-c", "--session-id", "--fork-session",
  "--permission-mode", "--permission-mode-before-plan",
  "--model", "-m", "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file", "--",
]);

export function checkCodebuddyLaunchArgs(args: SessionOptions["launchArgs"]): void {
  checkManagedLaunchArgs(args, CODEBUDDY_MANAGED_LAUNCH_ARGS, (flag) => `CodeBuddy launchArgs cannot override ${flag}; OAR owns the protocol, session identity, model and system prompt`, { camelCase: true });
}
