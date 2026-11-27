import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const bubRefusedSessionOptions: RefusedSessionOptions = {
  launchArgs: "bub acp takes only transport and protocol flags, which OAR owns; Bub's own settings are BUB_* variables in SessionOptions.env",
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  mcpServerCredentials: "OAR has not verified MCP credential isolation for Bub",
  fork: "Bub's ACP server has no session/fork",
  additionalDirectories: "OAR has not verified how Bub's ACP server uses additionalDirectories",
  appendSystemPrompt: "Bub's ACP server exposes no system prompt append channel",
  systemPrompt: "Bub's ACP server exposes no system prompt replacement channel",
  disallowedTools: "Bub's ACP server exposes no per-session tool-denial channel",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Bub turn's processes while its session stays usable",
  goals: "Bub has no structured goal controls",
  name: "This adapter has no verified session name setting for Bub",
  outputSchema: "Bub's ACP server exposes no final-output schema channel",
  serviceTier: "Bub's ACP server publishes no service-tier config option",
  userConfiguration: "Bub reads BUB_HOME's config and the workspace .env; OAR has not verified excluding user configuration from them",
  nativeMemoryDefault: "Bub exposes no verified below-user default layer for background memory",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "Bub's tools run without permission prompts; it has no native permission mode to inherit",
  userQuestions: "This adapter has no verified way for a host to answer the agent's questions",
};
