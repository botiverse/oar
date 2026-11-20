/** Logical credential or provider field controlled by a `CredentialVariable`. */
export type CredentialField =
  | "apiKey"
  | "authToken"
  | "baseUrl"
  | "headers"
  | "region"
  | "project"
  | "profile"
  | "model"
  | "provider"
  | "credentialSource"
  | "accountScope";

/** Value-interpolation syntax evaluated by a runtime when reading stored credential or config values. */
export interface CredentialInterpolation {
  /** Native syntax pattern (e.g. `"$VAR"`, `"!command"`, `"{env:VAR}"`). */
  readonly syntax: string;
  /** What the syntax resolves at load time: an environment variable or a shell command. */
  readonly target: "env" | "shell";
}

/**
 * The shape of the credentials a runtime reads on its own, never a value.
 * A host fills these from its own store; a variable marked `secret` never
 * goes on a command line. Every listed store is a place a credential can
 * come from, so a host that wants none supplied must account for each. Native login and logout are the `login` and
 * `logout` members; per-provider keys of a multi-provider runtime are
 * `providers`. Absent fields are unknown.
 */
export interface RuntimeCredentials {
  /** Whether credentials authenticate one runtime account or independent per-provider entries. */
  readonly scope?: "single_account" | "per_provider";
  /** `"native"` when the runtime owns credential management; `"external"` when it has no native login and the person or host supplies credentials. */
  readonly management?: "native" | "external";
  /** Paste kind expected by the runtime's sign-in prompt, when it exposes a sign-in flow. */
  readonly signInPaste?: "none" | "code" | "code_or_url";
  /** Store directory override env variable that `accountUsage()` reads, when the runtime exposes `accountUsage` and honors one. */
  readonly usageDirectoryEnv?: string;
  /** Value-interpolation syntaxes evaluated inside stored credential or config values. */
  readonly interpolation?: readonly CredentialInterpolation[];
  /** Variables that supply credentials or select their source, scope or destination. Store directory overrides are declared only in `stores`. Precedence applies within each native route. */
  readonly env?: readonly CredentialVariable[];
  /** Files and stores the runtime reads a credential from, in its own order of precedence, including ones the person edits (a `.env`). */
  readonly stores?: readonly CredentialStore[];
}

export interface CredentialVariable {
  readonly name: string;
  readonly purpose: "api_key" | "token" | "base_url" | "provider_selector" | "region" | "account_scope"
    | "model_route" | "credential_source" | "headers";
  readonly secret: boolean;
  /** Provider id that owns this variable in a multi-provider runtime (e.g. `"anthropic"`, `"openai"`). */
  readonly provider?: string;
  /** Logical credential field controlled by this variable for stripping, redaction and error attribution. */
  readonly field?: CredentialField;
}

/** A file or store the runtime reads credentials from; OAR neither reads nor writes the values. */
export interface CredentialStore {
  readonly kind: "file" | "dir" | "keychain";
  /** The variable that moves the directory holding the store (`DSH_HOME`); a host gives each agent its own by setting it. */
  readonly directoryEnv?: string;
  /** Additional directory-override variables checked in precedence order after `directoryEnv`. */
  readonly fallbackDirectoryEnvs?: readonly string[];
  /** The directory under the person's home when `directoryEnv` is unset (`.dsh`). */
  readonly defaultDirectory?: string;
  /** The store inside that directory (`.credentials.yaml`); absent for `keychain`. */
  readonly path?: string;
  /** OS keychain or keyring service name when statically known (`"Claude Code-credentials"`, `"Codex Auth"`). */
  readonly service?: string;
  /** `cwd`: `path` is relative to the session's working directory instead (a project `.env`). */
  readonly relativeTo?: "cwd";
  /** Whether a credential found here wins over the same one in the environment. */
  readonly overridesEnv?: boolean;
}
