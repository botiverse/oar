/*
 * The host-declared Pi provider, checked before a session starts and turned
 * into the shape Pi's model plane registers. No vendor behaviour is inferred:
 * the declaration says what it is, and OAR passes it through.
 */
import type { PiModelCompatibility, PiSessionCompaction, PiSessionProvider } from "../../contracts/pi-provider.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";

const PROVIDER_ID = /^[A-Za-z0-9][\w.-]*$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_]\w*$/u;

/** One model entry, in the shape Pi's provider registration takes. */
export interface PiProviderModelEntry {
  readonly id: string;
  readonly name: string;
  readonly input: ("text" | "image")[];
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly compat?: PiModelCompatibility;
}

/** The provider registration for one session, in the shape Pi's model plane takes. */
export interface PiProviderEntry {
  readonly name: string;
  readonly api: PiSessionProvider["api"];
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: PiProviderModelEntry[];
}

/** No pricing declared: Pi reports these models at zero cost rather than inventing one. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

function invalid(message: string): UnsupportedOptionError {
  return new UnsupportedOptionError("piProvider", message);
}

/**
 * Reject a declaration Pi cannot honour, before any session starts: a bad id,
 * an endpoint Pi would refuse, no models, duplicate or blank model ids, or a
 * window and completion limit that cannot both hold.
 */
export function checkPiProvider(provider: PiSessionProvider): void {
  if (!PROVIDER_ID.test(provider.id)) {
    throw invalid(`piProvider.id ${JSON.stringify(provider.id)} is not a provider id Pi accepts (letters, digits, dot, dash, underscore)`);
  }
  checkBaseUrl(provider.baseUrl);
  if (provider.apiKeyEnv !== undefined && !ENVIRONMENT_NAME.test(provider.apiKeyEnv)) {
    throw invalid(`piProvider.apiKeyEnv ${JSON.stringify(provider.apiKeyEnv)} is not an environment variable name: OAR passes the NAME of the variable holding the key, never the key`);
  }
  if (provider.models.length === 0) {
    throw invalid(`piProvider ${provider.id} declares no models: Pi needs at least one model to run a turn`);
  }
  const seen = new Set<string>();
  for (const model of provider.models) {
    // oxlint-disable-next-line no-control-regex -- A model id carrying a control character cannot be named on Pi's wire.
    if (model.id === "" || /[\u0000-\u001F]/u.test(model.id)) {
      throw invalid(`piProvider ${provider.id} declares a blank or control-character model id`);
    }
    if (seen.has(model.id)) {
      throw invalid(`piProvider ${provider.id} declares model ${model.id} twice`);
    }
    seen.add(model.id);
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) {
      throw invalid(`piProvider model ${model.id} needs a positive integer contextWindow`);
    }
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) {
      throw invalid(`piProvider model ${model.id} needs a positive integer maxTokens`);
    }
    if (model.maxTokens > model.contextWindow) {
      throw invalid(`piProvider model ${model.id} cannot emit more tokens (${model.maxTokens}) than its context window holds (${model.contextWindow})`);
    }
  }
}

function checkBaseUrl(baseUrl: string): void {
  const parsed = parseBaseUrl(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(`piProvider.baseUrl must be HTTP(S), not ${parsed.protocol}`);
  }
  if (parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") {
    throw invalid("piProvider.baseUrl must not carry a query, a fragment or credentials: OAR hands Pi the endpoint alone");
  }
}

function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw invalid(`piProvider.baseUrl ${JSON.stringify(baseUrl)} is not an absolute URL`);
  }
}

/**
 * The model this session runs. A bare id the declared provider serves is
 * qualified with the provider's id, which is how Pi names a model; anything
 * else (a qualified id, or a catalog model with no declared provider) is left
 * for Pi's own resolution.
 */
export function piProviderModelId(provider: PiSessionProvider, model: string): string | undefined {
  if (model.includes("/")) { return model; }
  return provider.models.some((entry) => entry.id === model) ? `${provider.id}/${model}` : model;
}

/** The provider's first declared model, qualified: what a new session runs when the host names none. */
function piFirstModel(provider: PiSessionProvider): string | undefined {
  const first = provider.models[0];
  return first === undefined ? undefined : `${provider.id}/${first.id}`;
}

/**
 * The model this session requests. An explicit id is qualified when it is a
 * bare id the provider serves; with none, a new session runs the provider's
 * first model and a resumed one keeps the model it recorded.
 */
export function piRequestedModel(provider: PiSessionProvider, model: string | undefined, resuming: boolean): string | undefined {
  if (model !== undefined) { return piProviderModelId(provider, model); }
  return resuming ? undefined : piFirstModel(provider);
}

/** The registration Pi's model plane takes for this declaration. */
export function piProviderEntry(provider: PiSessionProvider): PiProviderEntry {
  return {
    name: provider.id,
    api: provider.api,
    baseUrl: provider.baseUrl.replace(/\/+$/u, ""),
    ...(provider.apiKeyEnv === undefined ? {} : { apiKey: `$${provider.apiKeyEnv}` }),
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      input: [...(model.input ?? ["text"])],
      reasoning: model.reasoning ?? false,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost ?? NO_COST,
      ...(model.compat === undefined ? {} : { compat: model.compat }),
    })),
  };
}

/**
 * Reject a compaction budget Pi cannot honour. `reserveTokens` is the headroom
 * the trigger keeps free, so it has to leave room for a real turn but stay
 * under a real context window.
 */
export function checkPiCompaction(compaction: PiSessionCompaction): void {
  if (!Number.isSafeInteger(compaction.reserveTokens) || compaction.reserveTokens < 1) {
    throw new UnsupportedOptionError("piCompaction", `piCompaction.reserveTokens must be a positive integer, not ${compaction.reserveTokens}`);
  }
  if (compaction.keepRecentTokens !== undefined && (!Number.isSafeInteger(compaction.keepRecentTokens) || compaction.keepRecentTokens < 1)) {
    throw new UnsupportedOptionError("piCompaction", `piCompaction.keepRecentTokens must be a positive integer when given, not ${compaction.keepRecentTokens}`);
  }
}
