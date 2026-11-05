import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const antigravityRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Antigravity turn's processes while its session stays usable",
  userConfiguration: "antigravity has no verified separation of user configuration from its native login",
  additionalDirectories: "agy CLI 1.5.0 can select an additional workspace as the command cwd instead of preserving the primary cwd",
  outputSchema: "Antigravity ACP and launch configuration expose no final-output schema channel",
  name: "antigravity exposes no verified session name setting",
  serviceTier: "antigravity exposes no verified per-session service-tier setting and readback",
  systemPrompt: "agy CLI ACP exposes no verified system prompt replacement channel",
  disallowedTools: "agy CLI ACP exposes no verified tool-denial channel; _meta.antigravity.disabledTools is ignored in 1.5.0",
  // agy CLI 1.5.0 writes a session's `mcpServers`, `env` and `headers`
  // values included, in plain text into its conversation database
  // (`$GEMINI_HOME/antigravity-cli/conversations/<id>.db`).
  // The database outlives the session and a host
  // cannot see or clear it through ACP;
  // credentials reach a runtime only through its native channel, never its
  // disk. An entry without `env` or `headers` attaches as usual.
  mcpServerCredentials: "antigravity stores a session's MCP servers, env and header values included, in plain text in its conversation database, where they outlive the session; it attaches no entry with env or headers",
};
