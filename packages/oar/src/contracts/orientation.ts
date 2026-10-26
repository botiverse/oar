import type { AccountUsageSnapshot, UtcInstant } from "./account-usage.js";
import type { AuthStatus } from "./login.js";
import type { InstallationSnapshot } from "./installation.js";
import type { ModelEntry } from "./list-models.js";
import type { ProviderAuthStatus } from "./provider-auth.js";
import type { RuntimeBrand } from "./brand.js";
import type { SessionOptions } from "./session-options.js";

/** Facts, including missing evidence, without an embedded selection policy. */
export type Probe<T> =
  | { readonly kind: "ok"; readonly value: T; readonly observedAt: UtcInstant }
  | { readonly kind: "failed"; readonly reason: string; readonly observedAt: UtcInstant }
  | { readonly kind: "timed_out"; readonly observedAt: UtcInstant }
  | { readonly kind: "skipped"; readonly because: "not_installed" | "logged_out" | "depth" }
  | { readonly kind: "unsupported" };
export type OrientationDepth = "local" | "account" | "models";
export interface OrientOptions {
  /** Session overlay: strings override and null removes. Omitted for runtimes declaring refusedSessionOptions.env. */
  readonly env?: SessionOptions["env"];
  readonly depth?: OrientationDepth;
  readonly runtimes?: readonly string[];
  /** Starts native inventories, which can execute configuration and connect MCP servers. Never implicit in local. */
  readonly include?: readonly "customization"[];
  /** Overall wall-clock bound; default 60 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
/** Complete native catalogs with explicit user provenance only; ambiguous categories are omitted. */
export interface Customization {
  readonly skills?: number;
  readonly commands?: number;
  readonly mcpServers?: number;
  readonly tools?: number;
}
export interface RuntimeOrientation {
  readonly id: string;
  readonly brand: RuntimeBrand;
  readonly installation: Probe<InstallationSnapshot>;
  readonly auth: Probe<AuthStatus>;
  /** Local reads stored metadata without resolving credentials; account/models resolve it. */
  readonly providers?: Probe<readonly ProviderAuthStatus[]>;
  readonly accountUsage?: Probe<AccountUsageSnapshot>;
  readonly models?: Probe<readonly ModelEntry[]>;
  readonly customization?: Probe<Customization>;
}
export interface Orientation {
  readonly observedAt: UtcInstant;
  readonly depth: OrientationDepth;
  readonly runtimes: readonly RuntimeOrientation[];
}
export type UnusableReason = "not_installed" | "version_unsupported" | "logged_out" | "rate_limited" | "auth_unknown" | "probe_failed";
export interface RuntimeUsability {
  readonly id: string;
  readonly usable: boolean;
  readonly because?: UnusableReason;
}
export interface UsabilityOptions { readonly minVersions?: Readonly<Record<string, string>> }
