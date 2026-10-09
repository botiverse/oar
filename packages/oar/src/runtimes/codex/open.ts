import { sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { validateCodexToolDenials } from "./tool-denials.js";
import type { McpServer, RuntimeEventBody, SessionOptions } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { checkMcpServerNames, givenMcpServers, isHttpMcpServer } from "../../shared/mcp-servers.js";

/*
 * Opening a codex thread: the `thread/start` / `thread/resume` request built
 * from SessionOptions, and the reply read back against it. The record-stream
 * mapping lives in session.ts; this is the open-time policy it wraps.
 */

export type CodexOpenMethod = "thread/start" | "thread/resume";

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
  return Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
    ? { url: server.url, ...(server.headers === undefined ? {} : { http_headers: server.headers }), enabled: true }
    : { command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }), enabled: true }]));
}

/** A `config` param holding these overrides, or none when there are none. */
function configParams(config: JsonRecord): JsonRecord {
  return Object.keys(config).length === 0 ? {} : { config };
}

/**
 * The open request for these options: a new thread, or a resume of
 * `options.resume`; and the redactor for the MCP credentials its `config`
 * carries, through which every error codex reports for this session goes.
 */
export function codexThreadOpen(options: SessionOptions): { readonly method: CodexOpenMethod; readonly params: JsonRecord; readonly redact: (text: string) => string } {
  validateCodexToolDenials(options);
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
  if (options.resume === undefined) {
    return {
      method: "thread/start",
      redact,
      params: {
        cwd: options.cwd,
        ...modelParams,
        ...tierParams,
        approvalPolicy: "never",
        // Required in addition to initialize.experimentalApi. This exposes
        // the completed Responses API reasoning item, whose encrypted_content
        // lets us distinguish redaction from genuinely empty reasoning.
        experimentalRawEvents: true,
        ...instructionParams,
        ...configParams({ ...effortConfig, ...mcpConfig }),
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
      // Same-runtime model switch = resume the same thread id with a new
      // model. thread/resume accepts `model` (codex rust-v0.153.4,
      // protocol/v2/thread.rs ThreadResumeParams) and applies it when the
      // thread is loaded cold, which is the normal case here because every
      // oar session owns its own app-server process.
      ...modelParams,
      ...tierParams,
      approvalPolicy: "never",
      ...instructionParams,
      ...configParams(mcpConfig),
    },
  };
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
 * (`resumeEffort`). codex echoes an unknown level as given and forwards it
 * to the provider, whose refusal then fails the first turn.
 */
export function codexOpenReadback(
  method: CodexOpenMethod,
  options: SessionOptions,
  reply: JsonRecord,
): { readonly events: readonly RuntimeEventBody[]; readonly refusal: string | null; readonly resumeEffort: string | null } {
  const model = typeof reply.model === "string" ? reply.model : null;
  const effort = effortIn(reply);
  const events: RuntimeEventBody[] = [
    ...(model === null ? [] : [{ kind: "model" as const, model }]),
    ...(effort === null ? [] : [{ kind: "effort" as const, effort }]),
    ...codexServiceTierEvents(reply),
  ];
  if (options.model !== undefined && model !== null && model !== options.model) {
    return { events, refusal: `codex ${method} kept model ${model} although ${options.model} was requested`, resumeEffort: null };
  }
  if (options.serviceTier !== undefined && codexServiceTier(reply) !== options.serviceTier) {
    const actual = codexServiceTier(reply) ?? "unreported";
    return { events, refusal: `codex ${method} reports serviceTier ${actual} although ${options.serviceTier} was requested`, resumeEffort: null };
  }
  if (options.effort === undefined || effort === options.effort) {
    return { events, refusal: null, resumeEffort: null };
  }
  if (method === "thread/resume") {
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
