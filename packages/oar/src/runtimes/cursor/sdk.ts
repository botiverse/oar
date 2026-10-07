import { createRequire } from "node:module";
import path from "node:path";

/*
 * The part of `@cursor/sdk` (1.0.35) the adapter uses, narrowed so tests can
 * stand in for it. The SDK runs Cursor's agent in this process: a local
 * agent keeps its conversation under `~/.cursor/projects/<cwd>/`, and its
 * credential is `CURSOR_API_KEY` or, without it, the key
 * `Cursor.auth.login()` stored.
 *
 * The SDK is an optional peer dependency the host installs, so these types
 * are written out here rather than imported: OAR's published declarations
 * must not name a package a host may not have. The host hands the module
 * over (`createCursorRuntime({ sdk: () => import("@cursor/sdk") })`), and
 * its compile checks the real module against `CursorSdk`; in this repo the
 * CLI and the sea trial do, so its typecheck catches drift.
 */

export interface ModelParameterValue {
  readonly id: string;
  readonly value: string;
}

/** Also an argument the SDK takes, whose `params` it types as a mutable array. */
export interface ModelSelection {
  readonly id: string;
  readonly params?: ModelParameterValue[];
}

export interface ModelListItem {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly parameters?: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly values: readonly { readonly value: string; readonly displayName?: string }[];
  }[];
  readonly variants?: readonly {
    readonly params: readonly ModelParameterValue[];
    readonly displayName: string;
    readonly description?: string;
    readonly isDefault?: boolean;
  }[];
}

export type SteerAckOutcome = "complete_delivered" | "revert_to_followup";

interface CursorUserMessage {
  readonly text: string;
  readonly images?: { readonly data: string; readonly mimeType: string }[];
}

export type CursorDeltaListener = (args: { readonly update: unknown }) => void;

/** One send: a run of the agent loop until the agent ends it. */
export interface CursorRun {
  readonly id: string;
  /** Settles with the run's status once it ends (finished, error or cancelled). */
  wait(): Promise<unknown>;
  cancel(): Promise<void>;
  /** Present on runs that take mid-run input; settles once the agent took the text or handed it back. */
  steer?(text: string): Promise<SteerAckOutcome>;
}

export interface CursorAgent {
  readonly agentId: string;
  readonly model: ModelSelection | undefined;
  /** `local.force` takes the agent over from a run its store still holds as active. */
  send(message: string | CursorUserMessage, options: { readonly onDelta: CursorDeltaListener; readonly local?: { readonly force: boolean } }): Promise<CursorRun>;
  close(): void;
}

export interface CursorAgentOptions {
  readonly model: ModelSelection;
  readonly local: { readonly cwd: string; readonly sandboxOptions: { readonly enabled: boolean } };
}

/**
 * The SDK's on-disk credential store (`FileCredentialStore`, by default
 * `~/.cursor/sdk/auth.json`, the store `Cursor.auth.login()` and `status()`
 * use when given none). OAR only hands it what a login saves, unread.
 */
export interface CursorFileCredentialStore {
  save(credentials: object): Promise<void>;
}

/** A store passed to `Cursor.auth.login` (an `SdkCredentialStore`); the login only saves to it. */
export interface CursorLoginStore {
  load(): Promise<undefined>;
  save(credentials: object): Promise<void>;
  clear(): Promise<void>;
}

/** The part of `SdkLoginOptions` OAR passes. */
export interface CursorLoginOptions {
  readonly openBrowser: false;
  readonly onLoginUrl: (url: string) => void;
  readonly signal: AbortSignal;
  readonly store: CursorLoginStore;
}

/** What `Cursor.auth.status()` answers about the stored login; it never returns the key. */
export type CursorAuthStatus =
  | { readonly status: "logged-out" }
  | { readonly status: "logged-in"; readonly email?: string; readonly apiKeyExpiresAtMs?: number };

export interface CursorAuth {
  /** Resolves once the minted key is saved to `store`; OAR never reads what it resolves with (the key among it). */
  login(options: CursorLoginOptions): Promise<unknown>;
  status(): Promise<CursorAuthStatus>;
}

export interface CursorSdk {
  readonly Agent: {
    create(options: CursorAgentOptions): Promise<CursorAgent>;
    resume(agentId: string, options: CursorAgentOptions): Promise<CursorAgent>;
    listRuns(agentId: string, options: { readonly runtime: "local"; readonly cwd: string; readonly cursor?: string }): Promise<{
      readonly items: readonly { readonly model?: ModelSelection; readonly createdAt?: number }[];
      readonly nextCursor?: string;
    }>;
  };
  readonly Cursor: {
    readonly models: { list(): Promise<readonly ModelListItem[]> };
    /**
     * The SDK's own login (`Cursor.auth`, in 1.0.35). Optional, like
     * `FileCredentialStore`, so a host's own stand-in for the SDK keeps
     * compiling; without them `login` answers `version_unsupported` and
     * `authStatus` `unknown`.
     */
    readonly auth?: CursorAuth;
  };
  readonly FileCredentialStore?: new () => CursorFileCredentialStore;
}

/** The SDK through the host's loader, or the loader's failure in words. */
export async function loadedSdk(load: () => Promise<CursorSdk>): Promise<CursorSdk | { readonly failed: string }> {
  try {
    const sdk = await load();
    return sdk;
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

const SDK_PACKAGE = "@cursor/sdk";

/**
 * The SDK's native companion (`@cursor/sdk-<platform>-<arch>`: ripgrep and
 * the tree-sitter shell parser) is found by walking up from the host's entry
 * script for `node_modules/<package>`, which misses it in any layout that
 * does not hoist it (pnpm's, a bundled host): the agent then warns "tree-sitter
 * natives are unavailable" and searches without its own ripgrep. Resolved
 * from the SDK itself, the package is found wherever it was installed, and
 * the SDK's own variables point at it, unless the host set them. The
 * specifier is a variable so that a bundler does not try to resolve it; where
 * OAR cannot resolve the SDK, the SDK looks for itself.
 */
function nativePackageRoot(): string | null {
  try {
    const fromSdk = createRequire(import.meta.resolve(SDK_PACKAGE));
    return path.dirname(fromSdk.resolve(`${SDK_PACKAGE}-${process.platform}-${process.arch}/package.json`));
  } catch {
    return null;
  }
}

function pointSdkAtNativePackage(): void {
  const root = nativePackageRoot();
  if (root === null) {
    return;
  }
  process.env.CURSOR_TREE_SITTER_VENDOR_DIR ??= path.join(root, "vendor");
  process.env.CURSOR_RIPGREP_PATH ??= path.join(root, "bin", process.platform === "win32" ? "rg.exe" : "rg");
}

/**
 * The host's `sdk` loader, called once, on the first call that needs the
 * SDK: it is a large bundle with a native companion package per platform,
 * and a host that never opens cursor should not pay for it. A failed load is
 * retried by the next call.
 */
export function cursorSdkLoader(load: () => Promise<CursorSdk>): () => Promise<CursorSdk> {
  let loading: Promise<CursorSdk> | null = null;
  const attempt = async (): Promise<CursorSdk> => {
    try {
      // Yield first: a loader that throws synchronously would otherwise
      // reset `loading` before `??=` stores this failed attempt in it.
      await Promise.resolve();
      pointSdkAtNativePackage();
      const sdk = await load();
      return sdk;
    } catch (error) {
      loading = null;
      throw new Error("cursor could not load @cursor/sdk through the host's sdk loader", { cause: error });
    }
  };
  return async () => {
    loading ??= attempt();
    const sdk = await loading;
    return sdk;
  };
}
