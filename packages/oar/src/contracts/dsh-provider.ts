/*
 * The provider a host may declare for one DSH session, in DSH's own profile
 * vocabulary. DSH resolves every request through a provider route, so a host
 * whose model is not in DSH's catalog (a gateway, a private deployment) had to
 * write `llm-pi-ai` provider rows into the user's own `$DSH_HOME` patch before
 * `session()`. The declaration below instead travels in OAR's private
 * invocation `--patch`, an overlay for this session's process only: no user
 * file is written, no YAML is rendered and no script is run, because OAR
 * builds the rows itself from these typed fields.
 *
 * DSH alone takes it; every other runtime refuses it
 * (`refusedSessionOptions.dshProvider`).
 */

/** The wire protocols a host-declared DSH provider may speak: DSH's `llm-pi-ai` `api` names. */
export type DshWireProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

/**
 * The effort levels DSH's `llm-pi-ai` model entry accepts as
 * `reasoningEfforts` keys, ascending. `off` and `minimal` are DSH's own
 * lowest two; the rest is the familiar ladder to `max`.
 */
export type DshReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The reasoning levels one declared model offers, in three states:
 *
 * - omitted: OAR writes no level row, so DSH's own default for the model
 *   applies;
 * - `false`: the model selects no effort at all (DSH's `reasoningEfforts:
 *   false`), so `SessionOptions.effort` is refused for it natively at open;
 * - a record with at least one level: exactly those levels. Each key is a
 *   `DshReasoningLevel`, each value is the spelling THIS endpoint expects for
 *   that level, which is what DSH sends on the wire. OAR reads no vendor
 *   behavior out of a level name: a gateway that wants `high` on the wire for
 *   its highest setting says `{ high: "high" }`, and one that spells it
 *   `"HIGH"` says `{ high: "HIGH" }`.
 */
export type DshReasoningEfforts = false | Readonly<Partial<Record<DshReasoningLevel, string>>>;

/**
 * The wire quirks of one model, in DSH's `llm-pi-ai` vocabulary. OAR passes
 * these through unchanged and reads nothing out of the model id, the provider
 * id or the base URL, so an endpoint that differs from its wire's default
 * declares the difference here instead. Only the quirks that change what DSH
 * sends are exposed; the rest of `llm-pi-ai`'s compatibility switches stay
 * reachable through the user's own patch.
 */
export interface DshModelCompatibility {
  /** The endpoint rejects `store`. */
  readonly supportsStore?: boolean;
  /** The endpoint takes instructions as a `developer` role rather than `system`. */
  readonly supportsDeveloperRole?: boolean;
  /** Field the request carries the completion limit in. */
  readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Assistant turns must keep their reasoning content when sent back. */
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  /** How the wire carries the model's thinking. */
  readonly thinkingFormat?: "ant-ling" | "baseten" | "chat-template" | "deepseek" | "openai" | "openrouter" | "qwen" | "qwen-chat-template" | "string-thinking" | "together" | "zai";
}

/**
 * One model a host-declared DSH provider serves (`SessionOptions.dshProvider`).
 * The fields mirror DSH's `llm-pi-ai` model entry, and OAR passes each one
 * through unchanged.
 */
export interface DshSessionModel {
  /** The model's id under the provider. `SessionOptions.model` names it, bare or as `<providerId>/<id>`. */
  readonly id: string;
  /** Display name; the id when omitted. */
  readonly name?: string;
  /** Tokens the model can hold, prompt and completion together. DSH applies it to compaction and to its context read. */
  readonly contextWindow: number;
  /** Most tokens one completion may emit. Omitted keeps DSH's own default. */
  readonly maxTokens?: number;
  /** Modalities the model accepts. Omitted keeps DSH's own default (text). */
  readonly input?: readonly ("text" | "image")[];
  /** The selectable reasoning levels, in three states (`DshReasoningEfforts`). */
  readonly reasoningEfforts?: DshReasoningEfforts;
  /** The model's wire quirks (`DshModelCompatibility`), passed through verbatim. */
  readonly compat?: DshModelCompatibility;
}

/**
 * A provider the host declares for one DSH session, when the model it wants is
 * not in DSH's catalog: a private or hosted gateway reached with the host's own
 * model ids and its own wire spelling.
 *
 * The declaration becomes the session's `llm-pi-ai` configuration, in OAR's
 * private invocation `--patch`, for that process alone. DSH applies patch
 * layers over the profile's own layer and a layer replaces the config object it
 * names, so for this session's process the declared `providers` map is the
 * whole map: no user file is read or written, and no other session's routes
 * change. The credential travels as an environment variable NAME: OAR writes
 * `apiKeyEnv: NAME`, never the secret, and records neither.
 */
export interface DshSessionProvider {
  /** Provider id in DSH's namespace, `[A-Za-z0-9][A-Za-z0-9._-]*`. A model is then `<id>/<modelId>`. */
  readonly id: string;
  /** Wire protocol DSH speaks to `baseUrl`. */
  readonly api: DshWireProtocol;
  /** Absolute HTTP(S) endpoint, exactly as the wire expects it (including any version path segment). A trailing slash is dropped; a query, fragment or credentials in the URL are refused. */
  readonly baseUrl: string;
  /** NAME of the environment variable holding the API key: `SessionOptions.env`, the host environment, or DSH's own store. Omitted: DSH's own credential resolution for this provider applies. */
  readonly apiKeyEnv?: string;
  /** The models served. At least one, with unique ids. */
  readonly models: readonly DshSessionModel[];
}

/**
 * The DSH-only slice of `SessionOptions`. `SessionOptions` extends this, so the
 * option reads and types exactly like the rest of the object.
 */
export interface DshSessionSelection {
  /**
   * Declare the provider this DSH session runs, for a gateway or a model that
   * is not in DSH's catalog (`DshSessionProvider`). DSH only: every other
   * runtime refuses it (`refusedSessionOptions.dshProvider`). Honors go
   * through OAR's private invocation `--patch`, so no file under `$DSH_HOME` is
   * written and the user's own profile is untouched. `model` then names one of
   * its models, bare or qualified as `<id>/<modelId>`; a bare id this provider
   * declares is qualified with its id, a new session with no model runs the
   * provider's first model, and a resumed session with no model keeps the route
   * it saved. OAR confirms the declaration is in the session's model plane
   * before creating an agent, and rejects the open when DSH did not apply it.
   * `listModels` does not report it: the session's catalog reader sees the
   * installation's configuration, not one session's overlay.
   */
  readonly dshProvider?: DshSessionProvider;
}
