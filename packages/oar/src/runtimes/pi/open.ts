/* oxlint-disable import/max-dependencies -- SDK startup owns option validation, native settings, credentials, model resolution and lifecycle. */
import type { RefusedSessionOptions, SessionOptions } from "../../contracts/index.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { checkSessionName, refuseSessionOptions } from "../../shared/session-options.js";
import { sessionEnvironment } from "../../shared/environment.js";
import type { AgentSession as PiAgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { piCredentialExtension, rememberPiKey } from "./credentials.js";
import { preparePi } from "./static-modules.js";
import { disposePiAgentSession } from "./lifecycle.js";
import { piMcpExtensions, validatePiMcpEnvironment } from "./mcp.js";
import { piAgentDir, piFindSessionFile, piResolveModel, piSessionDir } from "./resolve.js";
import { checkPiProjectPackages, reportMissingPiPackages } from "./project.js";
import type { PiProjectOptions } from "./options.js";

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
  overlay: Readonly<Record<string, string | null>>,
): Promise<NonNullable<CreateAgentSessionOptions["customTools"]>[number]> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  return sdk.defineTool(sdk.createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: sessionEnvironment(overlay, context.env) }),
  }));
}

/** pi's thinking levels (`ThinkingLevel`, pi-agent-core 0.84.2): the spelling `SessionOptions.effort` takes on pi. */
export type PiThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

// Keyed by pi's own union, so a level pi adds or drops fails to compile here.
const PI_THINKING_LEVELS: Readonly<Record<PiThinkingLevel, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/**
 * `SessionOptions.effort` as a pi thinking level, or an Error naming pi's
 * levels. Checked before pi sees it: pi's `clampThinkingLevel` turns a word
 * it does not know into the model's lowest level without a word (pi-ai
 * 0.84.2 models.js), which the read-back would catch only after the session
 * was built.
 */
export function piThinkingLevel(effort: string): PiThinkingLevel {
  const level = Object.keys(PI_THINKING_LEVELS).find((candidate): candidate is PiThinkingLevel => candidate === effort);
  if (level === undefined) {
    throw new Error(`pi has no thinking level ${effort} (pi's levels: ${Object.keys(PI_THINKING_LEVELS).join(", ")})`);
  }
  return level;
}

/** The slice of pi's AgentSession the effort read-back depends on; structural for tests. */
export interface PiEffortSource extends PiModelSource {
  readonly thinkingLevel: string;
  getAvailableThinkingLevels(): readonly string[];
}

/**
 * Why the opened pi session does not run the requested thinking level, read
 * off pi's own state (`AgentSession.thinkingLevel`, what the next request
 * sends), or null when it does. pi clamps a level the model does not offer to
 * the nearest one it does (a non-reasoning model: `off`) without a word.
 */
export function piEffortRefusal(requested: string, session: PiEffortSource): string | null {
  if (session.thinkingLevel === requested) {
    return null;
  }
  const model = piEffectiveModel(session) ?? "no model";
  return `pi runs thinking level ${session.thinkingLevel} for ${model} although ${requested} was requested (the model offers ${session.getAvailableThinkingLevels().join(", ")})`;
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

/** Options the in-process SDK cannot honor, refused before anything opens. */
export const piRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  userConfiguration: "pi has no verified per-session exclusion of user configuration while retaining its native login",
  outputSchema: "Pi SDK exposes no final-output schema option",
  additionalDirectories: "pi's SDK configures one cwd and exposes no additional workspace directory option",
  launchArgs: "pi runs in this process through its SDK; there is no runtime command line to add arguments to",
  serviceTier: "pi exposes no verified per-session service-tier setting and readback",
};

/** Pi 1.4.0's truthy customPrompt check replaces an empty string with its default. */
export function checkPiSystemPrompt(prompt: string | undefined): void {
  if (prompt === "") {
    throw new UnsupportedOptionError("systemPrompt", "pi cannot replace its base system prompt with an empty string: native startup uses the default prompt instead");
  }
}

/**
 * Opens (or resumes) the pi AgentSession the adapter wraps. Services first
 * (createAgentSessionServices loads the agent dir's extensions and their
 * provider registrations into the ModelRuntime, exactly as `pi` itself does),
 * then the session against an explicit SessionManager so resume and creation
 * share one session directory.
 */
export async function openPiAgentSession(options: SessionOptions, rememberKey?: (key: string | undefined) => void, project: PiProjectOptions = {}): Promise<PiAgentSession> {
  refuseSessionOptions(piRefusedSessionOptions, options);
  checkSessionName(options);
  checkPiSystemPrompt(options.systemPrompt);
  validatePiMcpEnvironment(options);
  const thinkingLevel = options.effort === undefined ? undefined : piThinkingLevel(options.effort);
  const sdk = await import("@earendil-works/pi-coding-agent");
  // OAR_PI_AGENT_DIR pins pi's global config home (models.json/auth.json/
  // settings/sessions); same namespaced-env-pin pattern as OAR_CLAUDE_BIN.
  // This is how a host (or the pi-aimock behavior backend) points the
  // in-process model plane somewhere else.
  const agentDir = piAgentDir(() => sdk.getAgentDir());
  // The proxy plane before anything can reach a provider, from the same
  // settings manager the services get, so no second one is built (see
  // http.ts).
  const settingsManager = sdk.SettingsManager.create(options.cwd, agentDir, { projectTrusted: project.projectTrusted ?? true });
  await checkPiProjectPackages(options.cwd, agentDir, settingsManager, project);
  await reportMissingPiPackages(options.cwd, agentDir, settingsManager);
  await preparePi(settingsManager);
  // SessionOptions.mcpServers: pi's MCP extension plus one registering the
  // session's servers (mcp.ts); it refuses a name pi cannot take before
  // anything loads.
  const mcp = await piMcpExtensions(options, agentDir);
  const services = await sdk.createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    // System prompt seams: pi's DefaultResourceLoader natively supports both
    // replace (systemPrompt) and append (appendSystemPrompt). Replace swaps
    // pi's base prompt text only: pi's buildSystemPrompt (SDK 0.84.2
    // core/system-prompt.js) still puts its runtime-native additions AROUND
    // the replaced prompt: the append seam, then the project context files
    // (AGENTS.md), then the skills catalog of the agent dir and the host's
    // ~/.agents/skills, then the `Current working directory:` line. Those
    // are the runtime's, like codex's skills catalog around
    // baseInstructions; `noSkills` would drop every skill (project ones
    // included), which is more than a prompt replacement, so it is not set.
    resourceLoaderOptions: {
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [options.appendSystemPrompt] }),
      extensionFactories: [...(mcp?.extensions ?? []), ...(rememberKey === undefined ? [] : [{ name: "oar-credentials", factory: piCredentialExtension(rememberKey), hidden: true }])],
    },
  });
  mcp?.check(services.resourceLoader.getExtensions().errors);
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
  // process, but the processes the AGENT spawns do: a bash tool built with a
  // spawnHook overlaying the env replaces the builtin by name (custom tools
  // win the SDK's tool registry). Provider config (keys, base URLs) does NOT
  // travel this way for pi; that needs its native modelRuntime/agentDir
  // channel.
  const overlay = options.env;
  // Effort is pi's creation-time `thinkingLevel` (explicit wins over a resumed
  // session's recorded level and the settings default; pi clamps it to the
  // model). Not `AgentSession.setThinkingLevel`: that also writes the level
  // into pi's global settings as the user's new default (agent-session.js
  // 0.84.2). pi records the level in the session file for a new session and
  // for a resumed one that has none yet.
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    ...(options.disallowedTools === undefined ? {} : { excludeTools: [...options.disallowedTools] }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(overlay === undefined ? {} : { customTools: [await piEnvBashTool(options.cwd, overlay)] }),
  });
  if (options.resume !== undefined) {
    // Pi 1.3 restores the transcript's active tools, including a prior open's
    // exclusions. OAR's denylist belongs to this open. Restore the current
    // native defaults before session_start, whose extensions may change them.
    // Extra builtins (grep/find/ls) and default-inactive extension tools stay
    // inactive; Pi still applies this open's excludeTools and exposure rules.
    const defaults = settingsManager.getDefaultTools() ?? sdk.createCodingTools(options.cwd).map((tool) => tool.name);
    const registered = session.getAllTools();
    const extensions = registered.filter((tool) =>
      tool.sourceInfo.path !== `builtin:${tool.name}`
      && session.getToolDefinition(tool.name)?.defaultActive !== false
      && (tool.exposure === "direct" || tool.exposure === "model-only"));
    // Pi keeps unregistered transcript names pending until registration.
    // Its public setter clears those only when it deactivates an active tool.
    // Activate the registry first so even an empty default set clears them,
    // before session_start can register a default-inactive pending tool.
    session.setActiveToolsByName(registered.map((tool) => tool.name));
    if (session.getActiveToolNames().length === 0) {
      // A tool-free transcript needs no reset. Fold it with Pi's own public
      // helper, then omit registered and explicitly excluded names. Pattern
      // exclusions are left conservative rather than duplicating Pi's matcher.
      const { getCurrentTools } = await import("@earendil-works/pi-ai");
      const known = new Set([...registered.map((tool) => tool.name), ...(options.disallowedTools ?? [])]);
      if (getCurrentTools(sessionManager.buildSessionContext().messages).some((tool) => !known.has(tool.name))) {
        session.dispose();
        throw new UnsupportedOptionError("resume", "pi cannot reset restored pending tools on resume: transcript has unregistered tool names but no registered tool can be activated to clear them; open a new session instead");
      }
    }
    session.setActiveToolsByName([]);
    session.setActiveToolsByName([...defaults, ...extensions.map((tool) => tool.name)]);
  }
  // Read back rather than trust the request: the model record is the
  // runtime's report, and a resume that kept the old model must not pass.
  const effective = piEffectiveModel(session);
  if (options.model !== undefined && effective !== options.model) {
    session.dispose();
    throw new Error(`pi did not apply model ${options.model}: the session reports ${effective ?? "no model"}`);
  }
  const refusal = options.effort === undefined ? null : piEffortRefusal(options.effort, session);
  if (refusal !== null) {
    session.dispose();
    throw new Error(refusal);
  }
  // SessionOptions.name (#368), written as pi's own `--name` writes it: a
  // session_info entry on the session manager, so no extension sees a rename
  // event, and only once the checks above passed. A resumed session gets it
  // only if it never had one, so a name the user gave, or cleared, is kept.
  if (options.name !== undefined && !sessionManager.getEntries().some((entry) => entry.type === "session_info")) {
    sessionManager.appendSessionInfo(options.name);
  }
  // Like each CLI startup (including --resume/--continue), keep the SDK
  // default session_start reason: startup. bindExtensions emits it and
  // awaits resource discovery, whether or not MCP was requested.
  try {
    if (rememberKey !== undefined) { await rememberPiKey(new sdk.ModelRegistry(session.modelRuntime), session.model, rememberKey); }
    await session.bindExtensions({});
  } catch (error) {
    await disposePiAgentSession(session);
    throw error;
  }
  return session;
}
