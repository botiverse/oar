import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { checkManagedLaunchArgs } from "../../shared/launch-args.js";

export const qoderRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native Qoder fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  ephemeral: "This adapter has no verified switch to open an ephemeral session without native persistence",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Qoder turn's processes while its session stays usable",
  serviceTier: "Qoder has no verified service-tier option",
  outputSchema: "Qoder has no verified structured-output option for long-lived sessions",
  userConfiguration: "Qoder has no verified way to exclude user configuration while preserving native credentials and history",
  name: "Qoder's session-name persistence has not been verified",
  nativeMemoryDefault: "Qoder has no verified settings layer below user configuration for auto-memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

const QODER_MANAGED_LAUNCH_ARGS = new Set([
  "--print", "-p", "--input-format", "-f", "--output-format", "-o",
  "--include-partial-messages", "--no-include-partial-messages",
  "--replay-user-messages", "--no-replay-user-messages",
  "--session-id", "--resume", "-r", "--continue", "-c",
  "--sdk", "--acp", "--fork-session", "--remote", "--remote-session",
  "--permission-mode", "--permission-prompt-tool",
  "--model", "-m", "--reasoning-effort",
  "--system-prompt", "--system-prompt-file", "--append-system-prompt", "--append-system-prompt-file",
  "--name", "-n", "--",
]);

export function checkQoderLaunchArgs(args: readonly string[] | undefined): void {
  checkManagedLaunchArgs(args, QODER_MANAGED_LAUNCH_ARGS, (flag) => `Qoder launchArgs cannot override ${flag}; OAR owns the protocol, session identity, model, effort and system prompts`, { camelCase: true });
}
