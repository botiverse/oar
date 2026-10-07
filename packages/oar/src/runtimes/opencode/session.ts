import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { refuseSessionOptions } from "../../shared/session-options.js";

export const opencodeRefusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "opencode ACP does not expose a system prompt override",
  appendSystemPrompt: "opencode ACP does not expose a system prompt override",
  mcpServers: "OAR does not attach MCP servers to opencode yet: ACP session/new and session/resume mcpServers is not yet verified to reach its agent",
};

/**
 * `opencode acp` (1.18.30, live 2026-10-05; source packages/opencode/src/acp
 * at v1.18.34) is opencode's own ACP layer over its HTTP server, so the
 * mapping is upstream's.
 */
export const opencodeAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  // The ACP layer forwards only its own sessions' parts: a `task` subagent
  // runs in a child session whose frames never reach this transport, so the
  // call shows only as the parent's tool call (opaque, tier #1).
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  // Startup loads providers and the models.dev catalog before answering.
  requestTimeoutMs: 30_000,
  // No `authenticate`: the advertised `opencode-login` method answers `{}`;
  // credentials come from `opencode auth login` or provider env vars, and the
  // free opencode models need none.
  validateOptions: (options) => {
    refuseSessionOptions(opencodeRefusedSessionOptions, options);
  },
  // `session/set_model` answers `{}` and 1.18.30 pushes nothing, though the
  // switch applies; `set_config_option` on `model` answers every option with
  // its current value, the new model's effort menu included.
  modelViaConfigOption: true,
  // A prompt sent while one runs is admitted as a user message and the
  // running loop reads it at its next step (session/prompt.ts runLoop); both
  // prompt RPCs are answered when the session goes idle. Live: a steer sent
  // 2.5 s into a shell call changed that turn's final reply.
  steerParams: () => ({}),
  // A resume naming another directory ran in the session's own (live
  // 2026-10-05: `pwd` printed the original directory), so a resume
  // elsewhere is refused from `session/list` (profile.ts).
  resumeKeepsSessionCwd: true,
};

export const opencodeSession = acpSession(opencodeAcpProfile);
