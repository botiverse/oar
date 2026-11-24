/*
 * The provider a host may declare for one Pi session, and the compaction
 * budget that goes with it. Pi alone takes a host-declared provider in both of
 * its execution modes: the in-process SDK registers it in the session's model
 * plane, and the RPC child's own OAR extension registers it while it loads (no
 * `models.json`, no command line). Every other runtime refuses both options, and
 * so does Pi's RPC mode for the compaction budget: that child compacts from the
 * settings files it reads and exposes no per-session settings channel to an
 * extension (`refusedSessionOptions.piProvider`, `piCompaction`).
 */

/** The wire protocols a host-declared provider may speak; Pi's own names for them. */
export type PiWireProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

/** Pi's names for the thinking/reasoning carry a wire may use (`PiModelCompatibility.thinkingFormat`). */
export type PiThinkingFormat = "ant-ling" | "baseten" | "chat-template" | "deepseek" | "openai" | "openrouter" | "qwen" | "qwen-chat-template" | "string-thinking" | "together" | "zai";

/**
 * The wire quirks of one model, in Pi's own vocabulary. OAR passes these to Pi
 * unchanged and reads nothing out of the model id, the provider id or the base
 * URL, so a provider that differs from the wire's default (a gateway relaying a
 * reasoning model, for example) declares the difference here instead.
 *
 * Only the quirks that change what Pi sends are exposed. Anything Pi gains
 * later stays reachable through the runtime's own `models.json`.
 */
export interface PiModelCompatibility {
  /** The endpoint rejects `store`. */
  readonly supportsStore?: boolean;
  /** The endpoint takes instructions as a `developer` role rather than `system`. */
  readonly supportsDeveloperRole?: boolean;
  /** Field the request carries the completion limit in. */
  readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Assistant turns must keep their reasoning content when sent back. */
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  /** How the wire carries the model's thinking. */
  readonly thinkingFormat?: PiThinkingFormat;
}

/**
 * One model a host-declared Pi provider serves (`SessionOptions.piProvider`).
 * The fields mirror Pi's own `models.json` model entry, and OAR passes each one
 * through to Pi unchanged: it reads no vendor behaviour out of the id, the URL
 * or the name.
 */
export interface PiSessionModel {
  /** The model's id under the provider. `SessionOptions.model` names it, bare or as `<providerId>/<id>`. */
  readonly id: string;
  /** Display name; the id when omitted. */
  readonly name?: string;
  /** Tokens the model can hold, prompt and completion together. Pi applies it to compaction and to its context read. */
  readonly contextWindow: number;
  /** Most tokens one completion may emit. */
  readonly maxTokens: number;
  /** Modalities the model accepts. Text only when omitted. */
  readonly input?: readonly ("text" | "image")[];
  /** Whether the model exposes Pi's thinking levels. False when omitted. */
  readonly reasoning?: boolean;
  /**
   * The model's wire quirks in Pi's vocabulary (`PiModelCompatibility`),
   * passed through verbatim. This is where a host states how its gateway
   * carries a reasoning model, so OAR holds no rule of its own for any vendor.
   */
  readonly compat?: PiModelCompatibility;
  /** Display pricing per million tokens, passed through to Pi. Omitted declares no pricing, which Pi reports as zero cost. */
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}

/**
 * A provider the host declares for one Pi session, when the model it wants is
 * not in Pi's catalog: a private or hosted gateway reached with the host's own
 * model ids.
 *
 * OAR registers it in the session's model plane only. It writes no
 * `models.json` and changes no user configuration, so the declaration is per
 * session and the user's own Pi setup keeps working. The credential travels as
 * an environment variable NAME: OAR hands Pi `$NAME`, never the secret, and
 * records neither.
 */
export interface PiSessionProvider {
  /** Provider id in Pi's namespace. A model is then `<id>/<modelId>`. */
  readonly id: string;
  /** Wire protocol Pi speaks to `baseUrl`. */
  readonly api: PiWireProtocol;
  /** Absolute HTTP(S) endpoint. A trailing slash is dropped; a query, fragment or credentials in the URL are refused. */
  readonly baseUrl: string;
  /** NAME of the environment variable holding the API key: `SessionOptions.env`, the host environment, or Pi's own stored auth. Omitted leaves Pi's native provider auth in charge. */
  readonly apiKeyEnv?: string;
  /** The models served. At least one, with unique ids. */
  readonly models: readonly PiSessionModel[];
}

/**
 * The compaction budget for one Pi session, applied as Pi's own compaction
 * settings for that session only (never written to the user's settings file).
 */
export interface PiSessionCompaction {
  /** Tokens held back from the model's `contextWindow` as the compaction trigger's headroom. */
  readonly reserveTokens: number;
  /** Recent tokens a compaction keeps verbatim. Omitted keeps Pi's own default. */
  readonly keepRecentTokens?: number;
}

/**
 * The Pi-only slice of `SessionOptions`. `SessionOptions` extends this, so the
 * options read and type exactly like the rest of the object.
 */
export interface PiSessionSelection {
  /**
   * Declare the provider this Pi session runs, for a gateway or a model that is
   * not in Pi's catalog (`PiSessionProvider`). Pi only: every other runtime
   * refuses it (`refusedSessionOptions.piProvider`). Registered in the
   * session's model plane, so no `models.json` is written and the user's own Pi
   * configuration is untouched. `model` then names one of its models, bare or
   * qualified as `<id>/<modelId>`; a bare id this provider declares is
   * qualified with its id. Omitted: Pi's own catalog and `models.json` apply as
   * before. Honored in both Pi execution modes: in-process before the model
   * resolves, and in the RPC child by the OAR extension that starts with the
   * session, which registers it before Pi resolves `--model` and reports what
   * its model plane holds so a shortfall fails the open.
   */
  readonly piProvider?: PiSessionProvider;
  /**
   * Compaction budget for this Pi session (`PiSessionCompaction`). Pi only:
   * every other runtime refuses it. Applied to the session's own settings, so
   * the user's settings file is not modified. Omitted: Pi's own defaults and
   * per-model overrides apply. Refused in Pi's subprocess (RPC) execution mode:
   * that child compacts from the settings files it reads and no extension API
   * reaches its settings manager.
   */
  readonly piCompaction?: PiSessionCompaction;
}
