/*
 * The host-declared DSH provider, checked before a session starts and turned
 * into the `llm-pi-ai` rows DSH's profile loader takes, plus the audit the
 * session's bridge confirms once DSH has mounted them.
 *
 * No vendor behaviour is inferred: the declaration says what it is, OAR renders
 * the rows itself (structured JSON in a private `--patch`, never YAML text and
 * never a script), and the credential stays the NAME of an environment
 * variable. Rules Hikari-style hosts used to apply themselves — a `/v1` suffix,
 * a protocol suffix on the provider id, a gateway's compatibility defaults —
 * stay in the host: OAR passes the declared endpoint, id and compatibility
 * through unchanged.
 */
import type { DshModelCompatibility, DshReasoningEfforts, DshSessionModel, DshSessionProvider } from "../../contracts/dsh-provider.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { RESERVED_MCP_SERVER_NAMES } from "../../shared/mcp-servers.js";

/** The DSH plugin entry the declaration configures, and its package name. */
export const DSH_PROVIDER_PLUGIN = { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" } as const;

const PROVIDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_]\w*$/u;
const WIRE_PROTOCOLS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const REASONING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_TOKENS_FIELDS: ReadonlySet<string> = new Set(["max_completion_tokens", "max_tokens"]);
const THINKING_FORMATS: ReadonlySet<string> = new Set(["ant-ling", "baseten", "chat-template", "deepseek", "openai", "openrouter", "qwen", "qwen-chat-template", "string-thinking", "together", "zai"]);
const INPUTS: ReadonlySet<string> = new Set(["text", "image"]);

/** The 5 `llm-pi-ai` compatibility switches this contract exposes; the rest stay in the user's own patch. */
const BOOLEAN_COMPAT = ["supportsStore", "supportsDeveloperRole", "requiresReasoningContentOnAssistantMessages"] as const;

function invalid(message: string): UnsupportedOptionError {
  return new UnsupportedOptionError("dshProvider", message);
}

// oxlint-disable-next-line no-control-regex -- A value carrying a control character cannot be named on DSH's wire or in its YAML-based profile.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Reject a declaration DSH cannot honour, before anything starts: a provider id
 * DSH could not key a route by, a wire OAR does not speak for DSH, an endpoint
 * DSH would refuse, no models, duplicate or blank model ids, a completion limit
 * larger than the context window, a reasoning level DSH does not know, or a
 * compatibility value DSH's own schema would reject.
 */
export function checkDshProvider(provider: DshSessionProvider): void {
  if (!PROVIDER_ID.test(provider.id) || RESERVED_MCP_SERVER_NAMES.has(provider.id)) {
    throw invalid(`dshProvider.id ${JSON.stringify(provider.id)} is not a provider id DSH accepts: letters, digits, dot, dash and underscore, not starting with a dot or dash, and not a JavaScript object-member name`);
  }
  if (!WIRE_PROTOCOLS.has(provider.api)) {
    throw invalid(`dshProvider.api ${JSON.stringify(provider.api)} is not a wire OAR speaks for DSH (${[...WIRE_PROTOCOLS].join(", ")})`);
  }
  checkBaseUrl(provider.baseUrl);
  if (provider.apiKeyEnv !== undefined && !ENVIRONMENT_NAME.test(provider.apiKeyEnv)) {
    throw invalid(`dshProvider.apiKeyEnv ${JSON.stringify(provider.apiKeyEnv)} is not an environment variable name: OAR passes the NAME of the variable holding the key, never the key`);
  }
  // A JavaScript host may hand anything; a declaration with no models has no route.
  const models: readonly DshSessionModel[] = Array.isArray(provider.models) ? provider.models : [];
  if (models.length === 0) {
    throw invalid(`dshProvider ${provider.id} declares no models: DSH routes every request to a provider and a model`);
  }
  const seen = new Set<string>();
  for (const model of models) {
    checkModel(provider.id, model);
    if (seen.has(model.id)) {
      throw invalid(`dshProvider ${provider.id} declares model ${JSON.stringify(model.id)} twice`);
    }
    seen.add(model.id);
  }
}

function checkBaseUrl(baseUrl: string): void {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0 || CONTROL_CHARACTERS.test(baseUrl)) {
    throw invalid("dshProvider.baseUrl must be one absolute HTTP(S) URL");
  }
  const parsed = parseUrl(baseUrl);
  if (parsed === null) { throw invalid(`dshProvider.baseUrl ${JSON.stringify(baseUrl)} is not an absolute URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(`dshProvider.baseUrl must be HTTP(S), not ${parsed.protocol}`);
  }
  if (parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") {
    throw invalid("dshProvider.baseUrl must not carry a query, a fragment or credentials: OAR hands DSH the endpoint alone");
  }
}

function parseUrl(value: string): URL | null {
  try { return new URL(value.trim()); } catch { return null; }
}

function checkModel(providerId: string, model: DshSessionModel): void {
  const named = `dshProvider ${providerId} model ${JSON.stringify(model.id)}`;
  if (typeof model.id !== "string" || model.id.trim().length === 0 || CONTROL_CHARACTERS.test(model.id)) {
    throw invalid(`dshProvider ${providerId} declares a blank or control-character model id`);
  }
  if (model.name !== undefined && (model.name.trim().length === 0 || CONTROL_CHARACTERS.test(model.name))) {
    throw invalid(`${named} has a blank or control-character name`);
  }
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) {
    throw invalid(`${named} needs a positive integer contextWindow`);
  }
  if (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1)) {
    throw invalid(`${named} needs a positive integer maxTokens when given`);
  }
  if (model.maxTokens !== undefined && model.maxTokens > model.contextWindow) {
    throw invalid(`${named} cannot emit more tokens (${String(model.maxTokens)}) than its context window holds (${String(model.contextWindow)})`);
  }
  const inputs: readonly string[] = model.input ?? [];
  if (model.input !== undefined && inputs.length === 0) {
    throw invalid(`${named} must name at least one input modality when it gives input`);
  }
  for (const modality of inputs) {
    if (!INPUTS.has(modality)) { throw invalid(`${named} declares the unknown input modality ${JSON.stringify(modality)}`); }
  }
  if (new Set(inputs).size !== inputs.length) { throw invalid(`${named} names an input modality twice`); }
  if (model.reasoningEfforts !== undefined) { checkReasoningEfforts(named, model.reasoningEfforts); }
  if (model.compat !== undefined) { checkCompat(named, model.compat); }
}

function checkReasoningEfforts(named: string, efforts: DshReasoningEfforts): void {
  if (efforts === false) { return; }
  const levels = asRecord(efforts);
  if (levels === null) {
    throw invalid(`${named} gives reasoningEfforts as false (no level selection) or a map of levels to the spelling this endpoint expects`);
  }
  const entries = Object.entries(levels);
  if (entries.length === 0) {
    throw invalid(`${named} has an empty reasoningEfforts map: say false for a model with no level selection`);
  }
  for (const [level, spelling] of entries) {
    if (!REASONING_LEVELS.has(level)) {
      throw invalid(`${named} declares the unknown reasoning level ${JSON.stringify(level)} (${[...REASONING_LEVELS].join(", ")})`);
    }
    if (typeof spelling !== "string" || spelling.trim().length === 0 || CONTROL_CHARACTERS.test(spelling)) {
      throw invalid(`${named} maps reasoning level ${level} to no usable wire spelling`);
    }
  }
}

function checkCompat(named: string, compat: DshModelCompatibility): void {
  for (const key of BOOLEAN_COMPAT) {
    const value: unknown = compat[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw invalid(`${named} compat.${key} must be a boolean`);
    }
  }
  const maxTokensField: unknown = compat.maxTokensField;
  if (maxTokensField !== undefined && (typeof maxTokensField !== "string" || !MAX_TOKENS_FIELDS.has(maxTokensField))) {
    throw invalid(`${named} compat.maxTokensField must be one of ${[...MAX_TOKENS_FIELDS].join(", ")}`);
  }
  const thinkingFormat: unknown = compat.thinkingFormat;
  if (thinkingFormat !== undefined && (typeof thinkingFormat !== "string" || !THINKING_FORMATS.has(thinkingFormat))) {
    throw invalid(`${named} compat.thinkingFormat must be one of ${[...THINKING_FORMATS].join(", ")}`);
  }
}

/**
 * The model this session requests, as DSH names it (`<provider>/<model>`). A
 * bare id the declared provider serves is qualified with the provider's id; a
 * qualified id must name this provider and one of its models; with no model, a
 * new session runs the provider's first model and a resumed one keeps the route
 * it saved.
 */
export function dshProviderRequestedModel(provider: DshSessionProvider, model: string | undefined, resuming: boolean): string | undefined {
  const ids = provider.models.map((entry) => entry.id);
  if (model === undefined) {
    const first = ids[0];
    return resuming || first === undefined ? undefined : `${provider.id}/${first}`;
  }
  const separator = model.indexOf("/");
  const named = separator > 0 ? model.slice(0, separator) : provider.id;
  const modelId = separator > 0 ? model.slice(separator + 1) : model;
  if (named !== provider.id) {
    throw invalid(`this session declares provider ${JSON.stringify(provider.id)}, which is the only route it may use: ${JSON.stringify(model)} names ${JSON.stringify(named)}`);
  }
  if (!ids.includes(modelId)) {
    throw invalid(`the declared provider ${JSON.stringify(provider.id)} serves ${JSON.stringify(ids)}: ${JSON.stringify(model)} is not one of its models`);
  }
  return `${provider.id}/${modelId}`;
}

/**
 * The `llm-pi-ai` provider entry for one declaration, in DSH's own shape. Only
 * fields the host gave are written: an omitted `maxTokens`, `input`,
 * `reasoningEfforts` or `compat` stays DSH's decision for that model.
 */
export function dshProviderEntry(provider: DshSessionProvider): JsonRecord {
  return {
    ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv }),
    api: provider.api,
    baseURL: provider.baseUrl.trim().replace(/\/+$/u, ""),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      contextWindow: model.contextWindow,
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.input === undefined ? {} : { input: [...model.input] }),
      ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
      ...(model.compat === undefined ? {} : { compat: model.compat }),
    })),
  };
}

/**
 * The private invocation patch row that registers the declaration. DSH applies
 * `--patch` layers after the profile's own layer; a layer replaces the config
 * object it names, so this row is the session's whole `llm-pi-ai` config and
 * the user's file is never read or written.
 */
export function dshProviderPatchRow(provider: DshSessionProvider): JsonRecord {
  return { id: DSH_PROVIDER_PLUGIN.id, name: DSH_PROVIDER_PLUGIN.name, config: { providers: { [provider.id]: dshProviderEntry(provider) } } };
}

/**
 * What the session's bridge confirms once DSH has mounted the profile: the
 * declared provider is in `llm-pi-ai`'s applied config exactly as declared, and
 * the model plane resolves each of its models. Carries names and ids only — the
 * credential is the environment variable's NAME, never its value.
 */
export function dshProviderAudit(provider: DshSessionProvider): JsonRecord {
  const entry = dshProviderEntry(provider);
  return {
    pluginId: DSH_PROVIDER_PLUGIN.id,
    pluginName: DSH_PROVIDER_PLUGIN.name,
    id: provider.id,
    api: entry.api,
    baseURL: entry.baseURL,
    ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv }),
    models: provider.models.map((model) => model.id),
  };
}
