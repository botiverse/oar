import { createRequire } from "node:module";
import path from "node:path";
import type { ModelListItem, ModelSelection, RunResult, SDKUserMessage, SteerAckOutcome } from "@cursor/sdk";

export type { ModelListItem, ModelSelection, RunResult, SteerAckOutcome } from "@cursor/sdk";

/*
 * The part of `@cursor/sdk` (1.0.35) the adapter uses, narrowed so tests can
 * stand in for it. The SDK runs Cursor's agent in this process: a local
 * agent keeps its conversation under `~/.cursor/projects/<cwd>/`, and its
 * credential is `CURSOR_API_KEY` or the key `Cursor.auth.login()` stored.
 */

export type CursorDeltaListener = (args: { readonly update: unknown }) => void;

/** One send: a run of the agent loop until the agent ends it. */
export interface CursorRun {
  readonly id: string;
  /** Settles with the run's status once it ends (finished, error or cancelled). */
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
  /** Present on runs that take mid-run input; settles once the agent took the text or handed it back. */
  steer?(text: string): Promise<SteerAckOutcome>;
}

export interface CursorAgent {
  readonly agentId: string;
  readonly model: ModelSelection | undefined;
  /** `local.force` takes the agent over from a run its store still holds as active. */
  send(message: string | SDKUserMessage, options: { readonly onDelta: CursorDeltaListener; readonly local?: { readonly force: boolean } }): Promise<CursorRun>;
  close(): void;
}

export interface CursorAgentOptions {
  readonly model: ModelSelection;
  readonly local: { readonly cwd: string; readonly sandboxOptions: { readonly enabled: boolean } };
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
  };
}

let loading: Promise<CursorSdk> | null = null;

/**
 * The SDK's native companion (`@cursor/sdk-<platform>-<arch>`: ripgrep and
 * the tree-sitter shell parser) is found by walking up from the host's entry
 * script for `node_modules/<package>`, which misses it in any layout that
 * does not hoist it (pnpm's, a bundled host): the agent then warns "tree-sitter
 * natives are unavailable" and searches without its own ripgrep. Resolved
 * from the SDK itself, the package is found wherever it was installed, and
 * the SDK's own variables point at it, unless the host set them.
 */
function nativePackageRoot(): string | null {
  try {
    const fromSdk = createRequire(import.meta.resolve("@cursor/sdk"));
    return path.dirname(fromSdk.resolve(`@cursor/sdk-${process.platform}-${process.arch}/package.json`));
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

async function importSdk(): Promise<CursorSdk> {
  try {
    pointSdkAtNativePackage();
    return await import("@cursor/sdk");
  } catch (error) {
    loading = null;
    throw error;
  }
}

/**
 * The SDK is loaded on first use, not with OAR: it is a large bundle with a
 * native companion package per platform, and a host that never opens cursor
 * should not pay for it.
 */
export async function loadCursorSdk(): Promise<CursorSdk> {
  loading ??= importSdk();
  const sdk = await loading;
  return sdk;
}
