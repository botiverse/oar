import { sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import path from "node:path";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { validateCodexToolDenials } from "./tool-denials.js";
import type { McpServer, RuntimeEventBody, SessionOptions } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { checkMcpServerNames, givenMcpServers, isHttpMcpServer } from "../../shared/mcp-servers.js";
import { codexLaunchSandboxMode, codexRefusedSessionOptions, codexResumeSandboxParams } from "./options.js";
import { checkSessionName, refuseSessionOptions } from "../../shared/session-options.js";

/*
 * Opening a codex thread: the `thread/start` / `thread/resume` request built
 * from SessionOptions, and the reply read back against it. The record-stream
 * mapping lives in session.ts; this is the open-time policy it wraps.
 */

export type CodexOpenMethod = "thread/start" | "thread/resume" | "thread/fork";
export { codexLaunchSandboxMode } from "./options.js";

/** The names codex starts an MCP server under; any other fails that server's startup after the thread opened ([env] 0.160.1). */
const CODEX_MCP_SERVER_NAME = /^[\w:@/.-]+$/u;

/**
 * SessionOptions.mcpServers as codex's `mcp_servers` config table, one
 * entry per server: stdio `{command, args, env}`, http `{url, http_headers}`
 * ([env] 0.160.1 against a scripted provider: both start and their tools are
 * called). codex merges config overrides into the user's config.toml field
 * by field, so an entry named like one of the user's own is merged into it:
 * oar sets `args` (an array is replaced whole) and `enabled = true` so the
 * user's `args` or `enabled = false` cannot change or silently drop the
 * session's server; the user's other fields of that entry (more `env` keys,
 * `env_vars`, `cwd`, timeouts, tool filters) stay, and an entry of the other
 * transport fails the open ("url is not supported for stdio"). Nested under
 * one `mcp_servers` key rather than dotted `mcp_servers.<name>` keys, which
 * a `.` in a name would split. Throws on a list with an empty, repeated or
 * codex-invalid name.
 */
export function codexMcpServersConfig(servers: readonly McpServer[]): JsonRecord {
  checkMcpServerNames(servers);
  const invalid = servers.find((server) => !CODEX_MCP_SERVER_NAME.test(server.name));
  if (invalid !== undefined) {
    throw new Error(`codex starts no MCP server named ${JSON.stringify(invalid.name)}: its names match ${CODEX_MCP_SERVER_NAME.source}`);
  }
  return Object.fromEntries(servers.map((server) => {
    const required = server.required === true || (isHttpMcpServer(server) && server.origin === "serveMcpTools");
    const startup = required ? { required: true, startup_timeout_sec: 30 } : {};
    return [server.name, isHttpMcpServer(server)
      ? { url: server.url, ...(server.headers === undefined ? {} : { http_headers: server.headers }), enabled: true, ...startup }
      : { command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }), enabled: true, ...startup }];
  }));
}

/** A `config` param holding these overrides, or none when there are none. */
function configParams(config: JsonRecord): JsonRecord {
  return Object.keys(config).length === 0 ? {} : { config };
}

/** Native runtime roots replace the list, so retain the primary cwd too. */
function workspaceRoots(options: SessionOptions): string[] | null {
  const directories = resolvedAdditionalDirectories(options);
  return directories.length === 0 ? null : [...new Set([path.resolve(options.cwd), ...directories])];
}

/**
 * The open request for these options: a new thread, a resume of
 * `options.resume`, or a fork of it (SessionOptions.fork); and the redactor
 * for the MCP credentials its `config` carries, through which every error
 * codex reports for this session goes.
 */
export function codexThreadOpen(
  options: SessionOptions,
  sandboxMode: string = codexLaunchSandboxMode(options),
): { readonly method: CodexOpenMethod; readonly params: JsonRecord; readonly redact: (text: string) => string } {
  refuseSessionOptions(codexRefusedSessionOptions, options);
  validateCodexToolDenials(options);
  checkSessionName(options);
  const { redact } = sessionCredentialRedactor(options);
  // System prompt seams (probed 2026-08-24 via the aimock journal):
  // baseInstructions REPLACES codex's base prompt; developerInstructions
  // APPENDS as a developer message. "instructions"/"userInstructions" are
  // silently ignored by thread/start.
  const instructionParams = {
    ...(options.systemPrompt === undefined ? {} : { baseInstructions: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined ? {} : { developerInstructions: options.appendSystemPrompt }),
  };
  // Effort seam on a NEW thread (probed 2026-09-29, codex 0.155.1, aimock
  // provider): the config override `model_reasoning_effort` reaches every
  // turn's Responses request as `reasoning.effort`, a turn codex starts on
  // its own from its queue included, and is persisted with the thread. Not
  // on thread/resume: any config override there rebuilds the thread's
  // settings from config.toml, so a resumed thread without `model` came back
  // on the configured default model instead of its own ([env] live: a
  // gpt-6-luna thread resumed as gpt-6-astra). A resume sets the effort on
  // the loaded thread instead (codexResumeEffort). Per-turn `turn/start
  // {effort}` would miss a turn codex starts from its queue.
  const effortConfig = options.effort === undefined ? {} : { model_reasoning_effort: options.effort };
  // SessionOptions.mcpServers on BOTH methods: codex remembers none for a
  // thread. A resume carrying this override kept the thread's own model and
  // effort ([env] 0.160.1, scripted provider, pinned by the codex vendor
  // test), unlike the live rebuild above; not yet re-checked on a login.
  const mcpServers = givenMcpServers(options.mcpServers);
  const mcpConfig = mcpServers === null ? {} : { mcp_servers: codexMcpServersConfig(mcpServers) };
  const tierParams = options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier };
  const modelParams = options.model === undefined ? {} : { model: options.model };
  const roots = workspaceRoots(options);
  const directoryParams = roots === null ? {} : { runtimeWorkspaceRoots: roots };
  const approvalParams = options.nativePermissions === "inherit" ? {} : { approvalPolicy: "never" };
  const resumeSandboxParams = codexResumeSandboxParams(options, sandboxMode);
  if (options.resume === undefined) {
    return {
      method: "thread/start",
      redact,
      params: {
        cwd: options.cwd,
        ...directoryParams,
        ...modelParams,
        ...tierParams,
        ...approvalParams,
        // Required in addition to initialize.experimentalApi. This exposes
        // the completed Responses API reasoning item, whose encrypted_content
        // lets us distinguish redaction from genuinely empty reasoning.
        experimentalRawEvents: true,
        ...instructionParams,
        ...configParams({ ...effortConfig, ...mcpConfig }),
      },
    };
  }
  if (options.fork !== undefined) {
    // SessionOptions.fork: `thread/fork` loads the source from disk and opens
    // a new thread holding a copy of it, through `lastTurnId` inclusive
    // (codex 0.143.0 and later; an older schema has no such field, which
    // codex is expected to ignore (reasoned, not run), so session.ts refuses
    // `through` there before sending). The reply's thread is the new one,
    // so Session.id is the fork's. Unlike a cold resume it does not keep the
    // source's model and effort: without `model` it runs the configured
    // default, with or without a `config` override ([env] 0.169.0 and
    // 0.169.1: a gpt-5.2/high source forked onto gpt-5.1 with no effort).
    // Effort is set after the reply as on a resume; no `experimentalRawEvents`
    // (not a fork param); no `deferGoalContinuation`.
    const through = options.fork.through;
    return {
      method: "thread/fork",
      redact,
      params: {
        threadId: options.resume,
        ...(through === undefined ? {} : { lastTurnId: through }),
        excludeTurns: true,
        cwd: options.cwd,
        ...directoryParams,
        ...modelParams,
        ...tierParams,
        ...approvalParams,
        ...resumeSandboxParams,
        ...instructionParams,
        ...configParams(mcpConfig),
      },
    };
  }
  return {
    method: "thread/resume",
    redact,
    params: {
      threadId: options.resume,
      excludeTurns: true,
      cwd: options.cwd,
      ...directoryParams,
      // Same-runtime model switch = resume the same thread id with a new
      // model. thread/resume accepts `model` (codex rust-v0.153.4,
      // protocol/v2/thread.rs ThreadResumeParams) and applies it when the
      // thread is loaded cold, which is the normal case here because every
      // oar session owns its own app-server process.
      ...modelParams,
      ...tierParams,
      ...approvalParams,
      ...resumeSandboxParams,
      ...instructionParams,
      ...configParams(mcpConfig),
    },
  };
}

/**
 * SessionOptions.name (#368): the name to give the opened thread, or null. A
 * new thread, a fork included, gets it; a resumed one only when the resume
 * reply shows no name, so a name the user gave in their app is kept. The name reads back on the
 * thread ([env] codex 0.162.0, experiments/codex-session-name.ts).
 */
export function codexThreadName(method: CodexOpenMethod, options: SessionOptions, reply: JsonRecord): string | null {
  if (options.name === undefined) {
    return null;
  }
  const current = method === "thread/resume" ? asRecord(reply.thread)?.name : undefined;
  return typeof current === "string" && current.length > 0 ? null : options.name;
}

/** A reply's `reasoningEffort` (or `threadSettings.effort`): null when codex runs no explicit level (the model's default). */
function effortIn(record: JsonRecord | null): string | null {
  const effort = record?.reasoningEffort ?? record?.effort;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

/**
 * The open reply read back: the model and effort codex says the thread runs
 * (the open frame's events), why that is not what was requested, if it is
 * not, and the effort a resume still has to set on the loaded thread.
 *
 * Both replies report the model actually active. Still check it against the
 * request: codex's resume_running_thread ignores overrides for a thread that
 * is already loaded and busy (warn "thread/resume overrides ignored for
 * loaded thread") and answers with the old model; a caller who asked for a
 * model must not get one silently running another. The same holds for
 * effort: `reasoningEffort` is the level the thread runs (null: no explicit
 * level, the model's default). A resume answers the level the thread last
 * ran with; when that is not the requested one, it is set next
 * (`resumeEffort`), and so is a fork's. codex echoes an unknown level as given and forwards it
 * to the provider, whose refusal then fails the first turn.
 */
export function codexOpenReadback(
  method: CodexOpenMethod,
  options: SessionOptions,
  reply: JsonRecord,
): { readonly events: readonly RuntimeEventBody[]; readonly refusal: string | ModelConfirmationError | null; readonly resumeEffort: string | null } {
  const model = typeof reply.model === "string" ? reply.model : null;
  const effort = effortIn(reply);
  const events: RuntimeEventBody[] = [
    ...(model === null ? [] : [{ kind: "model" as const, model }]),
    ...(effort === null ? [] : [{ kind: "effort" as const, effort }]),
    ...codexServiceTierEvents(reply),
  ];
  // A fork must be a new thread; one answering with its source would be resumed, not forked.
  const threadId = asRecord(reply.thread)?.id;
  if (method === "thread/fork" && threadId === options.resume) {
    return { events, refusal: `codex thread/fork answered with its source thread ${String(threadId)}, not a new one`, resumeEffort: null };
  }
  const roots = workspaceRoots(options);
  const reportedRoots = reply.runtimeWorkspaceRoots;
  if (roots !== null && (!Array.isArray(reportedRoots) || roots.some((root) => !reportedRoots.includes(root)))) {
    return { events, refusal: `codex ${method} did not confirm the requested additionalDirectories in runtimeWorkspaceRoots`, resumeEffort: null };
  }
  if (options.model !== undefined && model !== null && model !== options.model) {
    return { events, refusal: new ModelConfirmationError(`codex ${method} kept model ${model} although ${options.model} was requested`, { requested: options.model, reported: model }), resumeEffort: null };
  }
  if (options.serviceTier !== undefined) {
    const reported = codexServiceTier(reply);
    const downgradedToDefault = options.serviceTierFallback === "default" && reported === "default";
    if (reported !== options.serviceTier && !downgradedToDefault) {
      const actual = reported ?? "unreported";
      return { events, refusal: `codex ${method} reports serviceTier ${actual} although ${options.serviceTier} was requested`, resumeEffort: null };
    }
  }
  if (options.effort === undefined || effort === options.effort) {
    return { events, refusal: null, resumeEffort: null };
  }
  if (method !== "thread/start") {
    return { events, refusal: null, resumeEffort: options.effort };
  }
  const said = "reasoningEffort" in reply ? `kept effort ${effort ?? "none (the model's default)"}` : "reports no reasoningEffort";
  return { events, refusal: `codex ${method} ${said} although effort ${options.effort} was requested`, resumeEffort: null };
}

/** How long a resume waits for codex's `thread/settings/updated` after its `thread/settings/update`. */
export const CODEX_SETTINGS_REPORT_MS = 10_000;

/**
 * Why the resumed thread does not run `requested` after
 * `thread/settings/update {effort}` ([env] 0.155.1: answered `{}`, then
 * `thread/settings/updated` with the thread's settings), or null when codex
 * reports exactly that level. `update` is the RPC's outcome, `settings` the
 * notification's params, or null when none came.
 */
export function codexResumeEffortRefusal(
  requested: string,
  update: { readonly error: string } | null,
  settings: JsonRecord | null,
): string | null {
  if (update !== null) {
    return `codex thread/settings/update effort=${requested} failed: ${update.error}`;
  }
  if (settings === null) {
    return `codex reported no thread/settings/updated within ${String(CODEX_SETTINGS_REPORT_MS)} ms, so effort ${requested} cannot be confirmed`;
  }
  const effort = effortIn(asRecord(settings.threadSettings));
  return effort === requested ? null : `codex thread/settings/update left effort ${effort ?? "none (the model's default)"} although ${requested} was requested`;
}

/** Null explicitly means no tier; an absent field is no evidence. */
export function codexServiceTier(record: JsonRecord | null): string | null {
  const value = record?.serviceTier;
  if (value === null) { return "default"; }
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function codexServiceTierEvents(record: JsonRecord | null): RuntimeEventBody[] {
  const serviceTier = codexServiceTier(record);
  return serviceTier === null ? [] : [{ kind: "service_tier", serviceTier }];
}
