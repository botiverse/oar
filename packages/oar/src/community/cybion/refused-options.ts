import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { dshOnlyRefusals, piOnlyRefusals } from "../../shared/session-options.js";

/** Options a Cybion session refuses, each with the reason the Agent API gives none. */
export const cybionRefusedSessionOptions: RefusedSessionOptions = {
  ...piOnlyRefusals,
  ...dshOnlyRefusals,
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  systemPrompt: "A Cybion Thread takes no per-session system prompt: its instructions are the Manuals Cybion loads for it",
  appendSystemPrompt: "A Cybion Thread takes no per-session system prompt: its instructions are the Manuals Cybion loads for it",
  env: "A Cybion Thread runs on its owner's Workers, not in this process",
  mcpServers: "Cybion's Agent API has no route that attaches an MCP server to a Thread",
  mcpServerCredentials: "Cybion's Agent API has no route that attaches an MCP server to a Thread",
  disallowedTools: "Cybion's Agent API has no per-Thread tool filter",
  launchArgs: "A Cybion Thread is a server-side object; a session launches no process",
  serviceTier: "Cybion's Agent API exposes a boolean fast-tier flag, not a named service tier",
  additionalDirectories: "A Cybion Thread runs on its owner's Workers, so a host directory means nothing to it",
  outputSchema: "Cybion's Agent API has no per-Thread structured output setting",
  userConfiguration: "A Cybion Thread always runs with its owner's configuration, which cannot be excluded",
  goals: "Cybion's Agent API exposes no structured goal controls",
  endTurnProcessesOnAbort: "Cybion cancels a turn, but exposes no per-turn control over the processes it started",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
};
