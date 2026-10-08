import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import type { StartSession, Session } from "../../contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { checkMcpServerNames } from "../../shared/mcp-servers.js";
import { prepareOpenCodePrompts, validateOpenCodePrompts, verifyOpenCodeAgent } from "./prompt-config.js";

/**
 * `opencode acp` (1.18.30, live 2026-10-05; source packages/opencode/src/acp
 * at v1.18.34) is opencode's own ACP layer over its HTTP server, so the
 * mapping is upstream's.
 */
export const opencodeRefusedSessionOptions: RefusedSessionOptions = {
  serviceTier: "opencode exposes no verified per-session service-tier setting and readback",
  disallowedTools: "opencode ACP has no session tool denylist; global permission rules can be overridden by agent rules and do not use the tool-name vocabulary consistently",
};

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

const directSession = acpSession(opencodeAcpProfile);

function withPromptCleanup(session: Session, cleanup: () => Promise<void>): Session {
  let unsubscribe: (() => void) | undefined = undefined;
  const observeCleanup = async (): Promise<void> => {
    try { await cleanup(); } catch { /* dispose awaits the same promise */ }
  };
  unsubscribe = session.rawEvents((record) => {
    if (record.kind === "response" && record.body.kind === "exited") {
      // Dispose also awaits this same cleanup promise and surfaces a failure.
      // Observe it here to avoid an unhandled rejection on unexpected exit.
      void observeCleanup();
      unsubscribe?.();
    }
  }, { sessionId: session.id, afterSeq: -1 });
  if (session.records().some((record) => record.kind === "response" && record.body.kind === "exited")) {
    unsubscribe();
  }
  let disposal: Promise<void> | undefined = undefined;
  const release = async (): Promise<void> => {
    try {
      await session.dispose();
    } finally {
      unsubscribe();
      await cleanup();
    }
  };
  return { ...session, dispose: async () => { disposal ??= release(); await disposal; } };
}

export const opencodeSession: StartSession = async (installation, options) => {
  refuseSessionOptions(opencodeRefusedSessionOptions, options);
  if (options.systemPrompt === undefined && options.appendSystemPrompt === undefined) {
    return directSession(installation, options);
  }
  // The prompts travel in OPENCODE_CONFIG_CONTENT, the session's MCP servers
  // in the ACP open as on the direct path; a list no runtime can attach fails
  // before the prompts are prepared.
  checkMcpServerNames(options.mcpServers ?? []);
  validateOpenCodePrompts(options);
  if (installation.via !== "executable") {
    throw new Error("opencode requires an executable installation");
  }
  const prepared = await prepareOpenCodePrompts(installation.command, options);
  try {
    const session = await acpSession({
      ...opencodeAcpProfile,
      // oxlint-disable-next-line typescript/promise-function-async -- Synchronous read-back through an async ACP hook.
      configureSession: ({ response }) => {
        if (prepared.agent !== undefined) {
          verifyOpenCodeAgent(response, prepared.agent);
        }
        return Promise.resolve();
      },
    })(installation, prepared.options);
    return withPromptCleanup(session, prepared.cleanup);
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
};
