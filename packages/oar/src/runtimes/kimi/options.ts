import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const kimiRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  userConfiguration: "kimi isolated homes cannot safely share native history: atomic writes replace the workspace-index link and split the workspace catalog",
  outputSchema: "Kimi ACP and launch configuration expose no final-output schema channel",
  name: "kimi exposes no verified session name setting",
  serviceTier: "kimi exposes no verified per-session service-tier setting and readback",
  disallowedTools: "kimi ACP exposes no session tool denylist; its agent-profile disallowedTools cannot be overlaid through the ACP launch or session options",
  systemPrompt: "kimi acp has no per-session system prompt input; its launcher does not forward --agent-file or --agent",
  appendSystemPrompt: "kimi acp has no per-session system prompt append input; its launcher does not forward --agent-file or --agent",
};
