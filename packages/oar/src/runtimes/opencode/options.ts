import { atLeastV2, parseOpencodeRelease, type OpencodeRelease } from "./version.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { RefusedSessionOptions, SessionCapabilityDeclaration } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

/**
 * `opencode acp` (1.18.30, live 2026-10-05; source packages/opencode/src/acp
 * at v1.18.34) is opencode's own ACP layer over its HTTP server, so the
 * mapping is upstream's.
 */
export const opencodeRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted OpenCode turn's processes while its session stays usable",
  userConfiguration: "opencode has no verified separation of user configuration from its native login",
  outputSchema: "OpenCode ACP exposes no final-output schema channel; its HTTP prompt format is not configurable through ACP",
  name: "opencode ACP exposes no verified session name setting",
  serviceTier: "opencode exposes no verified per-session service-tier setting and readback",
  disallowedTools: "opencode ACP has no session tool denylist; global permission rules can be overridden by agent rules and do not use the tool-name vocabulary consistently",
};

export const opencodeV1RefusedSessionOptions: RefusedSessionOptions = {
  ...opencodeRefusedSessionOptions,
  fork: "OAR has not verified a native copy of a saved OpenCode v1 session",
  additionalDirectories: "opencode v1 ACP exposes no additional workspace directory setting",
};

/** First v2 releases measured to apply each part of the overlay (experiments/opencode-v2-prompts). */
const V2_INSTRUCTIONS = { minor: 0, patch: 30, version: "2.0.30" } as const;
const V2_AGENT_LISTING = { minor: 2, patch: 0, version: "2.2.0" } as const;

export function opencodeV2PromptRefusals(release: OpencodeRelease): Pick<RefusedSessionOptions, "appendSystemPrompt" | "systemPrompt"> {
  return {
    ...(!atLeastV2(release, V2_INSTRUCTIONS) ? { appendSystemPrompt: `opencode ${release.version} does not load configured instructions; ${V2_INSTRUCTIONS.version} or later does` } : {}),
    ...(!atLeastV2(release, V2_AGENT_LISTING) ? { systemPrompt: `opencode ${release.version} cannot list its agents without the shared background service; ${V2_AGENT_LISTING.version} or later can` } : {}),
  };
}

export function opencodeSessionCapabilities(installation: AvailableInstallation): SessionCapabilityDeclaration {
  if (installation.via !== "executable" || installation.version === undefined) { return {}; }
  const release = parseOpencodeRelease(installation.version);
  if (release?.major === 1) {
    return {
      steer: true, refusedSessionOptions: opencodeV1RefusedSessionOptions,
      manualCompaction: { kind: "unsupported", reason: "OpenCode v1 ACP has no verified structural completion signal for /compact" },
    };
  }
  return release?.major === 2 ? { refusedSessionOptions: opencodeV2PromptRefusals(release), manualCompaction: { kind: "supported", activeTurn: "reject" } } : {};
}
