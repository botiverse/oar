import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { cursorRefusedSessionOptions, cursorSubprocessRefusedSessionOptions } from "./model.js";
import { cursorSdkLoader, type CursorSdk } from "./sdk.js";
import { openCursorChannel, type CursorChildExit } from "./subprocess/channel.js";
import { proxySdk } from "./subprocess/proxy.js";

/** The SDK for one session or one call, and what reaching it started. */
export interface CursorSdkLease {
  readonly sdk: CursorSdk;
  /** The environment the SDK and its tools run with. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** In subprocess mode, the child: its exit, observed once. Null in process. */
  readonly child: {
    onExit(listener: (exit: CursorChildExit) => void): void;
    stopping(): boolean;
  } | null;
  /** Ends what the lease started (the child and its tree), with its exit; null in process. */
  release(): Promise<CursorChildExit | null>;
}

/**
 * How the adapter reaches `@cursor/sdk`. `in_process`: the host's loaded
 * SDK, shared by every session and call, in the host's environment.
 * `subprocess`: a fresh Node child per session or call, which imports the
 * SDK itself, with its own environment (subprocess/).
 */
export interface CursorSdkAccess {
  readonly execution: "in_process" | "subprocess";
  /** The session options this mode refuses. */
  readonly refusedSessionOptions: RefusedSessionOptions;
  /** The environment a lease with `env` runs in, without opening one. */
  environment(env: SessionOptions["env"]): Readonly<NodeJS.ProcessEnv>;
  /** An SDK with `env` over the host's environment; rejects when the SDK cannot be loaded. */
  lease(env: SessionOptions["env"]): Promise<CursorSdkLease>;
}

/** Why the in-process mode refuses a nonempty `env` for login, logout and the status. */
export const IN_PROCESS_ENV = "Cursor authentication runs in the host process and cannot isolate env; configure the host environment before loading the SDK, or use the subprocess execution mode.";

/** The host's loaded SDK, or a whole access. A plain loader is the in-process mode. */
export type CursorSdkSource = (() => Promise<CursorSdk>) | CursorSdkAccess;

/**
 * The SDK in this process, through the host's loader. `loadOnce` wraps it
 * in `cursorSdkLoader` (one load, retried after a failure); tests that hand
 * over a loader of their own pass false. Callers refuse a nonempty `env` first.
 */
export function inProcessAccess(loader: () => Promise<CursorSdk>, loadOnce = false): CursorSdkAccess {
  const load = loadOnce ? cursorSdkLoader(loader) : loader;
  return {
    execution: "in_process",
    refusedSessionOptions: cursorRefusedSessionOptions,
    environment: () => process.env,
    async lease() {
      const sdk = await load();
      return { sdk, env: process.env, child: null, release: async () => { await Promise.resolve(); return null; } };
    },
  };
}

/**
 * One child per lease, importing `sdkModule`. Its environment is `env` over
 * the host's (`inherit`), or `env`'s string entries alone (`clean`); the
 * child adds only what it needs to run the SDK (subprocess/child-script.ts).
 */
export function subprocessAccess(sdkModule: string, envBase: "inherit" | "clean" = "inherit"): CursorSdkAccess {
  const environment = (overlay: SessionOptions["env"]): NodeJS.ProcessEnv => (envBase === "clean" ? sessionEnvironment(overlay, {}) : sessionEnvironment(overlay));
  return {
    execution: "subprocess",
    refusedSessionOptions: cursorSubprocessRefusedSessionOptions,
    environment,
    async lease(overlay) {
      const env = environment(overlay);
      const channel = await openCursorChannel(sdkModule, env);
      return { sdk: proxySdk(channel), env, child: channel, release: async () => { const exit = await channel.stop(); return exit; } };
    },
  };
}

export function cursorSdkAccess(source: CursorSdkSource): CursorSdkAccess {
  return typeof source === "function" ? inProcessAccess(source) : source;
}

/** Use a lease and release it; a lease that cannot be had is `{ failed }` with its reason. */
export async function withLease<T>(access: CursorSdkAccess, env: SessionOptions["env"], use: (sdk: CursorSdk, lease: CursorSdkLease) => Promise<T>): Promise<T | { readonly failed: string }> {
  let lease: CursorSdkLease | null = null;
  try {
    lease = await access.lease(env);
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await use(lease.sdk, lease);
  } finally {
    await lease.release();
  }
}
