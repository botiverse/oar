/**
 * Provider-independent authentication facade. Unlike a {@link Runtime} facet,
 * this describes the *provider* plane: the accounts and credentials a runtime
 * consumes (Anthropic, xAI, Moonshot, …), which is orthogonal to which harness
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

/**
 * One way a provider accepts a login, in the backend's own words. `method` is
 * what {@link ProviderAuthFacade.login} takes.
 */
export type LoginProviderMethod =
  | {
      readonly method: "oauth";
      /** The backend's name for this sign-in, e.g. `"Anthropic (Claude Pro/Max)"`. */
      readonly name: string;
      /**
       * True when the account behind it is a provider subscription (Claude
       * Pro/Max, ChatGPT, SuperGrok); false for a plain account sign-in
       * (OpenRouter, Radius).
       */
      readonly subscription: boolean;
      /**
       * The vendor's own label for this sign-in, e.g. `"Sign in with ChatGPT"`;
       * absent when it has none. Pi shows it in place of "Sign in with an
       * account" when a person asks to sign in to this provider (`/login openai`).
       */
      readonly loginLabel?: string;
    }
  | {
      readonly method: "api_key";
      /** The backend's name for the credential, e.g. `"Anthropic API key"` or `"AWS credentials or bearer token"`. */
      readonly name: string;
      /**
       * True when the backend has no prompt for it: the credential is
       * configured outside the backend (the environment, a cloud profile), so
       * `login` and `setApiKey` reject it and a host can only say so.
       */
      readonly ambient?: true;
    };

/** One provider a person can log in to, as the backend's registry has it. */
export interface LoginProvider {
  readonly providerId: string;
  /** The provider's display name, e.g. `"Anthropic"`. */
  readonly name: string;
  /** The ways it accepts a login, `oauth` before `api_key`; never empty. */
  readonly methods: readonly LoginProviderMethod[];
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
  /**
   * Every provider a person can log in to, configured or not, straight from
   * the backend's own registry (oar keeps no list of its own), in the order
   * its login menu shows them. Pi's `/login` builds its menu from the same
   * registry: "Sign in with an account" lists the providers with an `oauth`
   * method, "Sign in with an API key" those with an `api_key` method. Read
   * only, no credential read: `status` says how one is signed in.
   */
  loginProviders(): readonly LoginProvider[];
  /** The status of one provider (`configured: false` when nothing is stored). */
  status(providerId: string): Promise<ProviderAuthStatus>;
  /** Run the provider's OAuth or API-key login flow and persist the result. */
  login(
    providerId: string,
    method: ProviderLoginMethod,
    interaction: ProviderLoginInteraction,
  ): Promise<ProviderAuthStatus>;
  /**
   * Store an API key for a provider without an interactive flow: it answers
   * the provider's key prompt and nothing else. When the provider's API-key
   * login asks more (an auth method, an account id), it rejects, storing
   * nothing, and the error names `login(providerId, "api_key", interaction)`
   * as the way to sign that provider in.
   */
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  /** Clear a provider's stored credential. */
  logout(providerId: string): Promise<void>;
}
