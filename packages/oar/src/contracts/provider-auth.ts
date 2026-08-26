/**
 * Provider-independent authentication facade. Unlike a {@link Runtime} facet,
 * this describes the *provider* plane — the accounts and credentials a runtime
 * consumes (Anthropic, xAI, Moonshot, …) — which is orthogonal to which harness
 * runs them. Implementations wrap a credential/model backend (the built-in one
 * wraps Pi's `ModelRuntime`) without leaking its types.
 */

/** The two login methods a provider may accept. */
export type ProviderLoginMethod = "oauth" | "api_key";

/** A non-secret snapshot of one provider's stored auth. */
export interface ProviderAuthStatus {
  readonly providerId: string;
  /** Whether any usable credential is configured for this provider. */
  readonly configured: boolean;
  /** How the configured credential authenticates; omitted when not configured. */
  readonly method?: ProviderLoginMethod;
  /** Human-readable source label, e.g. `"OAuth"` or `"ANTHROPIC_API_KEY"`. */
  readonly label?: string;
  /** True when the credential is a subscription OAuth login rather than a metered key. */
  readonly subscription?: boolean;
}

/** An event surfaced while a login flow runs. */
export type ProviderLoginEvent =
  | { readonly kind: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly kind: "info"; readonly message: string };

/** A prompt the login flow needs the caller to answer. */
export type ProviderLoginPrompt =
  | {
      readonly kind: "text" | "secret" | "manual_code";
      readonly message: string;
      readonly placeholder?: string;
    }
  | {
      readonly kind: "select";
      readonly message: string;
      readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
    };

/**
 * Caller-supplied login interaction: observe flow events (the OAuth URL or
 * device code lands here) and answer prompts. This is the provider-independent
 * mirror of the backend's own interaction callback.
 */
export interface ProviderLoginInteraction {
  readonly signal?: AbortSignal;
  onEvent(event: ProviderLoginEvent): void;
  prompt(prompt: ProviderLoginPrompt): Promise<string>;
}

/**
 * List, inspect, and mutate provider credentials. Reading never resolves or
 * returns secret values; `login`/`setApiKey`/`logout` are the only writes.
 */
export interface ProviderAuthFacade {
  /** Every provider that has a configured credential, with its non-secret status. */
  listProviders(): Promise<readonly ProviderAuthStatus[]>;
  /** The status of one provider (`configured: false` when nothing is stored). */
  status(providerId: string): Promise<ProviderAuthStatus>;
  /** Run the provider's OAuth or API-key login flow and persist the result. */
  login(
    providerId: string,
    method: ProviderLoginMethod,
    interaction: ProviderLoginInteraction,
  ): Promise<ProviderAuthStatus>;
  /** Store an API key for a provider without an interactive flow. */
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  /** Clear a provider's stored credential. */
  logout(providerId: string): Promise<void>;
}
