import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/*
 * Declared refusals, apart from the session code so the runtime entry loads no
 * ACP SDK until a session opens. Each reason names the checked native surface,
 * not an absent OAR feature.
 */
export const hermesRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the gateway-owned turn's provider request",
  systemPrompt: "Hermes ACP exposes no system-prompt replacement channel; the gateway owns the profile's prompt",
  appendSystemPrompt: "Hermes ACP exposes no system-prompt append channel",
  launchArgs: "Hermes ACP accepts only its own flags; OAR has not verified arbitrary launch arguments through the gateway entry",
  outputSchema: "Hermes ACP exposes no final-output schema channel",
  name: "Hermes reports a session title but exposes no verified title setter over ACP",
  serviceTier: "Hermes advertises a service_tier config option for some models, but OAR has not verified its value semantics or readback",
  disallowedTools: "Hermes ACP exposes no session tool denylist",
  additionalDirectories: "Hermes ACP does not advertise sessionCapabilities.additionalDirectories",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Hermes turn's processes while its session stays usable",
  userConfiguration: "OAR has not verified isolating a Hermes session from the profile's user configuration, including selected parts of it",
  nativeMemoryDefault: "Hermes exposes no verified settings layer below user configuration for native memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  // The gateway binds editor MCP servers under a session scope that OAR has
  // not verified as ephemeral. A stdio entry without env attaches; a served
  // entry carries env, so it is refused rather than guessed at.
  mcpServerCredentials: "OAR has not verified that Hermes' gateway keeps session MCP env and header values out of its persisted profile state",
};
