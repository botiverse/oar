import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

/**
 * `opencode acp` (1.18.30, live 2026-10-05; source packages/opencode/src/acp
 * at v1.18.34) is opencode's own ACP layer over its HTTP server, so the
 * mapping is upstream's.
 */
export const opencodeRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  userConfiguration: "opencode has no verified separation of user configuration from its native login",
  outputSchema: "OpenCode ACP exposes no final-output schema channel; its HTTP prompt format is not configurable through ACP",
  name: "opencode ACP exposes no verified session name setting",
  serviceTier: "opencode exposes no verified per-session service-tier setting and readback",
  disallowedTools: "opencode ACP has no session tool denylist; global permission rules can be overridden by agent rules and do not use the tool-name vocabulary consistently",
};

export const opencodeV1RefusedSessionOptions: RefusedSessionOptions = {
  ...opencodeRefusedSessionOptions,
  additionalDirectories: "opencode v1 ACP exposes no additional workspace directory setting",
};
