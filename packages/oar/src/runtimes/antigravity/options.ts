import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const antigravityRefusedSessionOptions: RefusedSessionOptions = {
  outputSchema: "Antigravity ACP and launch configuration expose no final-output schema channel",
  name: "antigravity exposes no verified session name setting",
  additionalDirectories: "antigravity accepts but ignores ACP additionalDirectories",
  serviceTier: "antigravity exposes no verified per-session service-tier setting and readback",
  systemPrompt: "The Antigravity ACP server has no system prompt override in its protocol, launch options, or configuration",
  // agy_acp_server 1.4.0 writes a session's `mcpServers`, `env` and `headers`
  // values included, in plain text into its conversation database
  // (`$GEMINI_HOME/antigravity-acp/conversations/<id>.db`, 0600), which
  // outlives the session and which a host cannot see or clear through ACP;
  // credentials reach a runtime only through its native channel, never its
  // disk. An entry without `env` or `headers` attaches as usual.
  mcpServerCredentials: "antigravity stores a session's MCP servers, env and header values included, in plain text in its conversation database, where they outlive the session; it attaches no entry with env or headers",
};
