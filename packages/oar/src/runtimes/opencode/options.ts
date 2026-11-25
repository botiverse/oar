import { semverAtLeast } from "../../shared/semver.js";
import { atLeastV2, hasBackgroundChildUpdates, parseOpencodeRelease, type OpencodeRelease } from "./version.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { RefusedSessionOptions, SessionCapabilityDeclaration } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

/**
 * `opencode acp` (1.18.30, live 2026-10-05; source packages/opencode/src/acp
 * at v1.18.34) is opencode's own ACP layer over its HTTP server, so the
 * mapping is upstream's.
 */
export const opencodeRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted OpenCode turn's processes while its session stays usable",
  userConfiguration: "opencode has no verified separation of user configuration from its native login",
  outputSchema: "OpenCode ACP exposes no final-output schema channel; its HTTP prompt format is not configurable through ACP",
  name: "opencode ACP exposes no verified session name setting",
  serviceTier: "opencode exposes no verified per-session service-tier setting and readback",
  disallowedTools: "opencode ACP has no session tool denylist; global permission rules can be overridden by agent rules and do not use the tool-name vocabulary consistently",
  nativeMemoryDefault: "OpenCode exposes no verified below-user default layer for background auto-memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};

export const opencodeV1RefusedSessionOptions: RefusedSessionOptions = {
  ...opencodeRefusedSessionOptions,
  fork: "OAR has not verified a native copy of a saved OpenCode v1 session",
  additionalDirectories: "opencode v1 ACP exposes no additional workspace directory setting",
};

/** First v2 releases measured to apply each part of the overlay (experiments/opencode-v2-prompts). */
const V2_INSTRUCTIONS = { minor: 0, patch: 30, version: "2.0.30" } as const;
const V2_AGENT_LISTING = { minor: 2, patch: 0, version: "2.2.0" } as const;
/** 2.0.26: oldest v2 release tested calling stdio/HTTP echo tools (experiments/opencode-v2-2026-10-09.md, mcp-servers-acp.vendor.test.ts). */
const V2_MCP_HTTP = { minor: 0, patch: 26, version: "2.0.26" } as const;

export function opencodeV2PromptRefusals(release: OpencodeRelease): Pick<RefusedSessionOptions, "appendSystemPrompt" | "systemPrompt"> {
  return {
    ...(!atLeastV2(release, V2_INSTRUCTIONS) ? { appendSystemPrompt: `opencode ${release.version} does not load configured instructions; ${V2_INSTRUCTIONS.version} or later does` } : {}),
    ...(!atLeastV2(release, V2_AGENT_LISTING) ? { systemPrompt: `opencode ${release.version} cannot list its agents without the shared background service; ${V2_AGENT_LISTING.version} or later can` } : {}),
  };
}

export function opencodeSessionCapabilities(installation: AvailableInstallation): SessionCapabilityDeclaration {
  if (installation.via !== "executable" || installation.version === undefined) { return { stopTask: false }; }
  const release = parseOpencodeRelease(installation.version);
  if (release?.major === 1) {
    return {
      taskEventTypes: [],
      ...(semverAtLeast(installation.version, "1.19.5") ? { subagentResults: { foreground: "parent_tool_result" } } : {}),
      steer: true, stopTask: false, contextUsage: { tokens: true, contextWindow: true }, refusedSessionOptions: opencodeV1RefusedSessionOptions,
      // 1.18.30: oldest v1 release observed advertising mcpCapabilities.http and tested calling stdio/HTTP echo tools in mcp-servers-acp.vendor.test.ts.
      ...(semverAtLeast(installation.version, "1.18.30") ? { mcpTransports: ["stdio", "http"] as const } : {}),
      manualCompaction: { kind: "unsupported", reason: "OpenCode v1 ACP has no verified structural completion signal for /compact" },
    };
  }
  if (release?.major !== 2) { return { stopTask: false }; }
  const background = hasBackgroundChildUpdates(release);
  return {
    taskEventTypes: background ? ["agent"] : [],
    ...(background ? { subagentResults: { background: "child_text" } as const } : {}),
    ...(!background && atLeastV2(release, { minor: 2, patch: 7 }) ? { subagentResults: { foreground: "parent_tool_result" } as const } : {}),
    stopTask: false, contextUsage: { tokens: true, contextWindow: true },
    ...(atLeastV2(release, V2_MCP_HTTP) ? { mcpTransports: ["stdio", "http"] as const } : {}),
    refusedSessionOptions: opencodeV2PromptRefusals(release), manualCompaction: { kind: "supported", activeTurn: "reject" },
  };
}
