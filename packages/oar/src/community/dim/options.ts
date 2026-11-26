import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { checkManagedLaunchArgs } from "../../shared/launch-args.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const dimRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  mcpServerCredentials: "OAR has not verified MCP credential isolation for Dim",
  fork: "OAR has not verified Dim's session/fork as a whole-session copy, and ACP session/fork cannot cut after a chosen turn",
  additionalDirectories: "Dim's ACP gateway refuses non-empty additionalDirectories (0.1.0-alpha.29)",
  appendSystemPrompt: "Dim's ACP gateway exposes no system prompt append channel",
  systemPrompt: "Dim's ACP gateway exposes no system prompt replacement channel",
  disallowedTools: "Dim's ACP gateway exposes no per-session tool-denial channel",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Dim turn's processes while its session stays usable",
  goals: "This adapter does not map Dim's goal commands to structured goal controls",
  name: "This adapter has no verified session name setting for Dim",
  outputSchema: "Dim's ACP gateway exposes no final-output schema channel",
  serviceTier: "Dim's ACP gateway does not publish service-tier config options (0.1.0-alpha.29)",
  userConfiguration: "Dim keeps providers, accounts and sessions in one home; OAR has not verified excluding user configuration from it",
  nativeMemoryDefault: "Dim exposes no verified below-user default layer for background memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter sets Dim's full-access mode; inheriting the native permission mode is unverified",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

/*
 * `dima acp` takes `--home`, `--server`, `--model-config` and `--agent`; these
 * flags would change the protocol, the session or settings OAR owns. Dim
 * itself refuses `--model`, `--effort` and `--permission` with `acp`.
 */
const DIM_MANAGED_LAUNCH_ARGS = new Set([
  "acp", "--auth-setup", "--cwd", "--prompt", "-p", "--resume", "--json",
  "--provider", "--model", "--effort", "--permission",
]);

export function checkDimLaunchArgs(args: SessionOptions["launchArgs"]): void {
  checkManagedLaunchArgs(args, DIM_MANAGED_LAUNCH_ARGS, (flag) => `Dim launchArgs cannot override ${flag}; OAR owns the ACP subcommand, working directory, session identity, model and permission mode`);
}
