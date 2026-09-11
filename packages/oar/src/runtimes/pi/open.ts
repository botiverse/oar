import type { AgentSession as PiAgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { SessionOptions } from "../../contracts/session.js";
import { piFindSessionFile, piResolveModel, piSessionDir } from "./resolve.js";

/*
 * Opening the bundled pi SDK session: services, session file (create or
 * resume by id), model resolution and read-back. The record-stream mapping
 * lives in session.ts; this file is the SDK-facing setup it wraps.
 */

/**
 * The bash tool that carries SessionOptions.env into the agent's spawned
 * processes: same builtin bash, plus a spawnHook overlaying the env. pi's
 * defineTool keeps the definition assignable to customTools, where it
 * replaces the builtin by name. Exported for direct unit verification.
 */
export async function piEnvBashTool(
  cwd: string,
  overlay: Readonly<Record<string, string>>,
): Promise<NonNullable<CreateAgentSessionOptions["customTools"]>[number]> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  return sdk.defineTool(sdk.createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...overlay } }),
  }));
}

/** The slice of pi's AgentSession the model read-back depends on; structural for tests. */
export interface PiModelSource {
  readonly model: { readonly provider: string; readonly id: string } | undefined;
}

/**
 * pi's `AgentSession.model` (SDK 0.84.2 agent-session.d.ts: "Current model
 * (may be undefined if not yet selected)") is the runtime-owned current
 * model, updated by setModel/model switching; spelled `provider/id` like the
 * list-models projection and pi's own `--model` flag.
 */
export function piEffectiveModel(session: PiModelSource): string | null {
  const { model } = session;
  return model === undefined ? null : `${model.provider}/${model.id}`;
}

/**
 * Opens (or resumes) the pi AgentSession the adapter wraps. Services first
 * (createAgentSessionServices loads the agent dir's extensions and their
 * provider registrations into the ModelRuntime, exactly as `pi` itself does),
 * then the session against an explicit SessionManager so resume and creation
 * share one session directory.
 */
export async function openPiAgentSession(options: SessionOptions): Promise<PiAgentSession> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  // OAR_PI_AGENT_DIR pins pi's global config home (models.json/auth.json/
  // settings/sessions) — same namespaced-env-pin pattern as OAR_CLAUDE_BIN.
  // This is how a host (or the pi-aimock behavior backend) points the
  // in-process model plane somewhere else.
  const agentDir = process.env.OAR_PI_AGENT_DIR ?? sdk.getAgentDir();
  // YOLO by default (repo policy): pi gates tool execution on project trust,
  // which is an approval prompt no embedded host can answer — pre-trust the
  // session cwd the same way pi's own Trust button would (auditable in
  // <agentDir>/trust.json).
  new sdk.ProjectTrustStore(agentDir).set(options.cwd, true);
  const services = await sdk.createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    // System prompt seams: pi's DefaultResourceLoader natively supports both
    // replace (systemPrompt) and append (appendSystemPrompt).
    resourceLoaderOptions: {
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [options.appendSystemPrompt] }),
    },
  });
  // pi persists sessions per cwd under <agentDir>/sessions; the same
  // directory is used to create (so a later resume finds the file) and to
  // look a resumed id up.
  const sessionDir = piSessionDir(options.cwd, agentDir);
  const sessionManager = options.resume === undefined
    ? sdk.SessionManager.create(options.cwd, sessionDir)
    : sdk.SessionManager.open(
        await piFindSessionFile(sdk.SessionManager, options.resume, options.cwd, sessionDir),
        sessionDir,
      );
  // An explicit model wins over the one recorded in a resumed session
  // (sdk.js createAgentSession precedence, same in the services path); the
  // recorded one is restored only when none is given.
  const model = options.model === undefined ? undefined : piResolveModel(services.modelRuntime, options.model);
  // Per-session env on an in-process runtime: the runtime itself has no own
  // process, but the processes the AGENT spawns do — a bash tool built with a
  // spawnHook overlaying the env replaces the builtin by name (custom tools
  // win the SDK's tool registry). Provider config (keys, base URLs) does NOT
  // travel this way for pi; that needs its native modelRuntime/agentDir
  // channel.
  const overlay = options.env;
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model === undefined ? {} : { model }),
    ...(overlay === undefined ? {} : { customTools: [await piEnvBashTool(options.cwd, overlay)] }),
  });
  // Read back rather than trust the request: the model record is the
  // runtime's report, and a resume that kept the old model must not pass.
  const effective = piEffectiveModel(session);
  if (options.model !== undefined && effective !== options.model) {
    session.dispose();
    throw new Error(`pi did not apply model ${options.model}: the session reports ${effective ?? "no model"}`);
  }
  return session;
}
