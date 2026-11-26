import type { AvailableInstallation } from "../../contracts/installation.js";
import type { RefusedSessionOptions, SessionCapabilityDeclaration } from "../../contracts/runtime.js";
import { semverAtLeast } from "../../shared/semver.js";
import { isKimiKapBotiverseVersion } from "./version.js";
import { dshOnlyRefusals, piOnlyRefusals } from "../../shared/session-options.js";

/* Declared refusals and installation capabilities, apart from the session code so the runtime entry loads no SDK until a session opens. */

export const KIMI_ACP_APPEND_SYSTEM_PROMPT_REFUSAL = "kimi acp has no per-session system prompt append input; its launcher does not forward --agent-file or --agent";

export const kimiRefusedSessionOptions: RefusedSessionOptions = {
  ...piOnlyRefusals,
  ...dshOnlyRefusals,
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native Kimi fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Kimi turn's processes while its session stays usable",
  userConfiguration: "kimi isolated homes cannot safely share native history: atomic writes replace the workspace-index link and split the workspace catalog",
  outputSchema: "Kimi ACP and launch configuration expose no final-output schema channel",
  name: "kimi exposes no verified session name setting",
  serviceTier: "kimi exposes no verified per-session service-tier setting and readback",
  disallowedTools: "kimi ACP exposes no session tool denylist; its agent-profile disallowedTools cannot be overlaid through the ACP launch or session options",
  systemPrompt: "kimi acp has no per-session system prompt input; its launcher does not forward --agent-file or --agent",
  nativeMemoryDefault: "Kimi exposes no verified below-user default layer for background auto-memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

export const kimiAcpRefusedSessionOptions: RefusedSessionOptions = {
  ...kimiRefusedSessionOptions,
  appendSystemPrompt: KIMI_ACP_APPEND_SYSTEM_PROMPT_REFUSAL,
};

const ACP_MANUAL_COMPACTION = { kind: "unsupported", reason: "The ACP transport reports compaction as ordinary text, without a structural completion signal." } as const;

export function kimiSessionCapabilities(installation: AvailableInstallation): SessionCapabilityDeclaration {
  if (installation.via === "executable" && isKimiKapBotiverseVersion(installation.version)) {
    return {
      taskEventTypes: ["agent", "shell"],
      subagentResults: { foreground: "parent_tool_result", background: "child_text" },
      steer: true,
      images: true,
      stopTask: true,
      contextUsage: { tokens: true, contextWindow: true },
      mcpTransports: ["stdio", "http"],
      manualCompaction: { kind: "supported", activeTurn: "reject" },
      compactionEvents: { started: true, ended: true },
    };
  }
  if (installation.via === "executable" && semverAtLeast(installation.version, "2.7.3")) {
    return {
      subagentResults: { foreground: "parent_tool_result" },
      contextUsage: { tokens: true, contextWindow: true },
      mcpTransports: ["stdio", "http"],
    };
  }
  return {
    taskEventTypes: [],
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.6.3") ? { subagentResults: { foreground: "parent_tool_result" } } : {}),
    steer: false,
    stopTask: false,
    contextUsage: { tokens: true, contextWindow: true },
    // 2.1.1: oldest version observed advertising mcpCapabilities.http and tested calling stdio/HTTP echo tools in mcp-servers-acp.vendor.test.ts.
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.1.1") ? { mcpTransports: ["stdio", "http"] as const } : {}),
    refusedSessionOptions: { appendSystemPrompt: KIMI_ACP_APPEND_SYSTEM_PROMPT_REFUSAL },
    manualCompaction: ACP_MANUAL_COMPACTION,
  };
}
