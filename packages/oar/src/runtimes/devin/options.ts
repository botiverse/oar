import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const devinRefusedSessionOptions: RefusedSessionOptions = {
  additionalDirectories: "Devin ACP does not advertise additionalDirectories",
  appendSystemPrompt: "Devin ACP exposes no verified system prompt append channel",
  disallowedTools: "Devin ACP exposes no verified tool-denial channel",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Devin turn's processes while its session stays usable",
  goals: "This runtime interface exposes no structured native goal controls",
  name: "Devin exposes no verified session name setting",
  outputSchema: "Devin ACP and launch configuration expose no final-output schema channel",
  serviceTier: "Devin exposes no verified per-session service-tier setting and readback",
  systemPrompt: "Devin ACP exposes no verified system prompt replacement channel",
  userConfiguration: "Devin has no verified separation of user configuration from its native login",
};
