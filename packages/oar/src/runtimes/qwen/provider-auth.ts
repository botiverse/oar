import type { ExecutableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session-options.js";

export interface QwenProviderAuthOptions {
  /** Native settings are loaded relative to this directory; defaults to the host cwd. */
  readonly cwd?: string;
  /** The session overlay: strings override, null removes. The host is untouched. */
  readonly env?: SessionOptions["env"];
  /** Total initialization and request budget per operation, default 30 seconds. Cleanup follows. */
  readonly timeoutMs?: number;
}

/** Qwen's provider menu metadata. Additional native UI fields are retained as JSON. */
export interface QwenProvider {
  readonly id: string;
  readonly label: string;
  readonly protocol: string;
  /**
   * Qwen's existing settings-file configuration, returned unchanged. It excludes
   * process environment, .env and security.auth.apiKey, and depends on cwd.
   * Presence (even hasApiKey) is not credential validity; absence is not logout.
   * Use qwenRuntime.authStatus for the broader local credential observation.
   */
  readonly existingConfig?: Readonly<Record<string, unknown>>;
  readonly [nativeField: string]: unknown;
}

export interface QwenProviderConnectOptions {
  readonly providerId: string;
  /** Sent only on ACP stdin. Omit to let Qwen reuse a stored key, if it can. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly protocol?: "openai" | "anthropic" | "gemini";
  readonly wireApi?: "chat-completions" | "responses";
  readonly modelIds?: readonly string[];
  /** Omit to leave the destination to Qwen; 0.26.2 probes observed user settings. */
  readonly scope?: "user" | "workspace";
}

/** Native configuration completion, not a claim that the provider accepts the key. */
export interface QwenProviderConnectResult {
  readonly success: true;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly authType: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
}

/** No OAuth or logout: Qwen's native provider extensions expose neither operation. */
export interface QwenProviderAuth {
  /** Starts one bounded native ACP reader. Does not create a conversation or send a prompt. */
  listProviders(): Promise<readonly QwenProvider[]>;
  /**
   * Qwen owns validation, persistence and scope. Success means configuration was
   * written, not remote authentication; run a turn to test provider acceptance.
   * A timeout or lost process can leave an unknown write outcome. No automatic retry.
   */
  connect(options: QwenProviderConnectOptions): Promise<QwenProviderConnectResult>;
}

export type QwenProviderAuthErrorKind = "native" | "timeout" | "process_exited" | "launch_failed" | "invalid_response";

/** Native ACP code is preserved; raw messages, data, stderr and causes may contain stored keys and are omitted. */
export class QwenProviderAuthError extends Error {
  readonly kind: QwenProviderAuthErrorKind;
  readonly method: string;
  readonly code: number | undefined;

  constructor(kind: QwenProviderAuthErrorKind, method: string, code?: number) {
    super(`Qwen ${method} failed: ${kind}${code === undefined ? "" : ` (ACP ${code})`}`);
    this.name = "QwenProviderAuthError";
    this.kind = kind;
    this.method = method;
    this.code = code;
  }
}

/** Create the native provider-settings facade. Processes are started only by its operations. */
export async function createQwenProviderAuth(
  installation: ExecutableInstallation,
  options: QwenProviderAuthOptions = {},
): Promise<QwenProviderAuth> {
  const { qwenProviderAuth } = await import("./provider-auth-rpc.js");
  return qwenProviderAuth(installation, options);
}
