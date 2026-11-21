import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { checkManagedLaunchArgs } from "../../shared/launch-args.js";
import { semverAtLeast } from "../../shared/semver.js";

export const qwenRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native Qwen fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Qwen turn's processes while its session stays usable",
  userConfiguration: "qwen has no verified separation of user configuration from its native login",
  serviceTier: "Qwen's stream-json interface does not expose a service-tier setting",
  outputSchema: "Qwen rejects --json-schema with its long-lived stream-json input protocol",
  name: "Qwen's stream-json interface does not expose a session-name readback",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
};

/** Qwen 0.26.0+ supports lowering native auto-memory defaults via QWEN_CODE_SYSTEM_DEFAULTS_PATH. */
export function qwenNativeMemoryRefusal(version: string | undefined): Pick<RefusedSessionOptions, "nativeMemoryDefault"> {
  return semverAtLeast(version, "0.26.0")
    ? {}
    : { nativeMemoryDefault: "Qwen below 0.26.0 has no verified system-defaults memory toggle; 0.26.0 or later is required" };
}

const QWEN_MANAGED_LAUNCH_ARGS = new Set([
  "--input-format", "--output-format", "--channel", "--approval-mode", "--yolo", "-y",
  "--include-partial-messages", "--no-include-partial-messages",
  "--session-id", "--resume", "-r", "--continue", "-c", "--fork-session", "--acp",
  "--prompt", "-p", "--json-schema", "-o", "--prompt-interactive", "-i",
  "--model", "-m", "--system-prompt", "--append-system-prompt",
  "--experimental-acp", "--json-fd", "--json-file", "--input-file",
  "--sandbox-session-id", "--list-extensions", "-l", "--",
]);

/** A second protocol, identity, or approval selector would invalidate the session OAR opens. */
export function checkQwenLaunchArgs(args: readonly string[] | undefined): void {
  checkManagedLaunchArgs(args, QWEN_MANAGED_LAUNCH_ARGS, (flag) => `Qwen launchArgs cannot override ${flag}; OAR owns the stream-json protocol, session identity, approval mode, model, system prompts and output schema`, { camelCase: true });
}
