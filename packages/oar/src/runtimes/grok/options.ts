import type { AvailableInstallation } from "../../contracts/installation.js";
import type { RefusedSessionOptions, SessionCapabilityDeclaration } from "../../contracts/runtime.js";
import { semverAtLeast } from "../../shared/semver.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const grokRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native Grok fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  ephemeral: "This adapter has no verified switch to open an ephemeral session without native persistence",
  userConfiguration: "grok has no verified separation of user configuration from its native login",
  additionalDirectories: "grok ACP exposes no effective additional workspace directory setting",
  serviceTier: "grok exposes no verified per-session service-tier setting and readback",
  name: "grok exposes no verified session name setting",
  disallowedTools: "grok agent stdio does not forward the CLI tool denylist; supplying an agent profile would replace the user's selected harness rather than overlay its tools",
  nativeMemoryDefault: "Grok has no verified settings layer below user configuration for cross-session memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

export function grokSessionCapabilities(installation: AvailableInstallation): SessionCapabilityDeclaration {
  return {
    ...(installation.via === "executable" && semverAtLeast(installation.version, "1.0.70") ? { taskEventTypes: ["agent"], subagentResults: { foreground: "parent_tool_result", background: "task_output" } } : {}),
    steer: true, images: true, stopTask: false, contextUsage: { tokens: true, contextWindow: false },
    // 1.0.46: oldest version observed advertising mcpCapabilities.http and tested calling stdio/HTTP echo tools in mcp-servers-acp.vendor.test.ts.
    ...(installation.via === "executable" && semverAtLeast(installation.version, "1.0.46") ? { mcpTransports: ["stdio", "http"] as const } : {}),
  };
}
