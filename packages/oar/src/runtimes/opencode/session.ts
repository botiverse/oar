// BYOK change: Modified from OAR 95c6547 for SDK-owned processes and explicit environments (Apache-2.0).
/* oxlint-disable import/max-dependencies -- Session profiles and assembly wire the native control, projection and lifecycle helpers. */
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { opencodeRefusedSessionOptions, opencodeV1RefusedSessionOptions } from "./options.js";
import { opencodeCompaction, opencodeCompactionEvents } from "./compaction.js";
import { opencodeMajor } from "./version.js";
import { opencodeChildAttribution } from "./attribution.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import type { AdapterSession as Session } from "../../contracts/session.js";
import type { StartAcpSession } from "../../shared/acp/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { checkMcpServerNames } from "../../shared/mcp-servers.js";
import { opencodeFailureOutcome } from "./failure.js";
import { prepareOpenCodePrompts, validateOpenCodePrompts, verifyOpenCodeAgent } from "./prompt-config.js";

export const opencodeAcpProfile: AcpSessionProfile = {
  args: ["acp"],
  failureOutcome: opencodeFailureOutcome,
  validateOptions: (options) => { refuseSessionOptions(opencodeV1RefusedSessionOptions, options); },
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
  // These runtimes lack a unique native missing-session code (#294).
};

const directSession = acpSession(opencodeAcpProfile);
const { steerParams: _v1SteerParams, ...commonProfile } = opencodeAcpProfile;
export const opencodeV2RefusedSessionOptions: RefusedSessionOptions = {
  ...opencodeRefusedSessionOptions,
  appendSystemPrompt: "opencode v2 does not load the instructions configuration used for session-local appended prompts; ACP exposes no equivalent transient instruction channel",
  systemPrompt: "opencode v2 uses agents.<id>.system, but ACP exposes no per-session replacement and OAR cannot yet safely resolve and override the selected agent across new sessions and resume",
};
export const opencodeV2AcpProfile: AcpSessionProfile = {
  ...commonProfile,
  compaction: opencodeCompaction, projectUpdate: opencodeCompactionEvents,
  capabilities: { queue: { durable: false }, attribution: "nested" },
  attributeUpdate: opencodeChildAttribution,
  validateOptions: (options) => { refuseSessionOptions(opencodeV2RefusedSessionOptions, options); },
};
const directV2Session = acpSession(opencodeV2AcpProfile);

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
  return { ...session, dispose: async () => {
    // BYOK change: a failed reclaim must remain retryable; concurrent callers still share the in-flight release.
    disposal ??= release().catch((error: unknown) => { disposal = undefined; throw error; });
    await disposal;
  } };
}

// BYOK: processes, environment and observation are owned by the SDK ACP bridge.
export const opencodeSession: StartAcpSession = async (spawn, terminal, installation, options, hooks) => {
  if (installation.via !== "executable" || installation.version === undefined) throw new Error("opencode requires a probed executable version");
  refuseSessionOptions(opencodeRefusedSessionOptions, options);
  // Invalid MCP entries fail before even the release-line helper can start.
  checkMcpServerNames(options.mcpServers ?? []);
  if (await opencodeMajor(installation, options) === 2) {
    return directV2Session(spawn, terminal, installation, options, hooks);
  }
  refuseSessionOptions(opencodeV1RefusedSessionOptions, options);
  if (options.systemPrompt === undefined && options.appendSystemPrompt === undefined) {
    return directSession(spawn, terminal, installation, options, hooks);
  }
  // The prompts travel in OPENCODE_CONFIG_CONTENT, the session's MCP servers
  // in the ACP open as on the direct path, after validation above.
  validateOpenCodePrompts(options);
  const prepared = await prepareOpenCodePrompts(installation.command, options, async (command, args, query) => {
    const env = Object.fromEntries(Object.entries(query.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const process = terminal(command, args, { cwd: query.cwd, env, shell: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retained = 0;
    let refuse!: (error: Error) => void;
    const refused = new Promise<never>((_, reject) => { refuse = reject; });
    const retain = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      retained += chunk.length;
      if (retained > 2 * 1024 * 1024) { refuse(new Error("opencode configuration query exceeded its output budget")); return; }
      (stream === "stdout" ? stdout : stderr).push(chunk);
    };
    process.child.stdout?.on("data", (chunk: Buffer) => { retain("stdout", chunk); });
    process.child.stderr?.on("data", (chunk: Buffer) => { retain("stderr", chunk); });
    const closed = new Promise<number | null>((resolve, reject) => {
      process.child.once("close", resolve);
      process.child.once("error", reject);
    });
    void closed.catch(() => {});
    void refused.catch(() => {});
    try {
      timer = setTimeout(() => { refuse(new Error("opencode configuration query timed out")); }, query.timeoutMs);
      await process.spawned;
      const exitCode = await Promise.race([closed, refused]);
      return { ok: exitCode === 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode };
    } finally { clearTimeout(timer); await process.dispose(); }
  });
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
    })(spawn, terminal, installation, { ...prepared.options, env: prepared.options.env as Readonly<Record<string, string>> }, hooks);
    return withPromptCleanup(session, prepared.cleanup);
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
};
