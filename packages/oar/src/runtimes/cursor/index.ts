import { runtimeBrands } from "../../brands.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { inProcessAccess, subprocessAccess, type CursorSdkAccess } from "./access.js";
import { cursorAuthStatusWith } from "./auth-status.js";
import { cursorInstallationFor } from "./installation.js";
import { cursorListModelsWith } from "./list-models.js";
import { cursorLoginWith } from "./login.js";
import { cursorLogoutWith } from "./logout.js";
import type { CursorSdk } from "./sdk.js";
import { cursorSessionWith } from "./session.js";

/** The default mode: the SDK runs in the host process. */
export interface CursorInProcessOptions {
  readonly execution?: "in_process";
  /**
   * Loads `@cursor/sdk` 1.3.1, which the host installs (an optional peer
   * dependency of OAR): `() => import("@cursor/sdk")`. Written in the host's
   * own code, the import fails the host's compile when the package is
   * missing, checks the SDK's types against `CursorSdk`, and is visible to
   * a bundler. Called on the first call that needs the SDK; a failed load is
   * retried by the next call.
   */
  readonly sdk: () => Promise<CursorSdk>;
  /** Subprocess mode only: in process, the SDK's tools always see the host's environment. */
  readonly envBase?: never;
}

/** Each session, and each model listing, login, logout and status call, runs the SDK in a Node child process of its own. */
export interface CursorSubprocessOptions {
  readonly execution: "subprocess";
  /**
   * What the child passes to `import()` to load `@cursor/sdk` 1.3.1: a file
   * URL, e.g. `import.meta.resolve("@cursor/sdk")` in the host's own code.
   * The host never loads the SDK itself in this mode, so nothing checks the
   * module's types against `CursorSdk` at compile time.
   */
  readonly sdkModule: string;
  /**
   * What a child's environment starts from before the session's or call's
   * `env` is applied. `inherit` (the default): the host's whole
   * `process.env`, as for process runtimes. `clean`: nothing; the child gets
   * only the string entries of `env`, plus what OAR adds to run the SDK
   * (docs/runtimes/cursor.md#child-environment). A host that wants an
   * allowlist uses `clean` and passes what Node and the SDK need, such as
   * PATH and HOME.
   */
  readonly envBase?: "inherit" | "clean";
}

export type CursorRuntimeOptions = CursorInProcessOptions | CursorSubprocessOptions;

/** A cursor runtime: its probe, model listing, login, logout, status and refusals are always there. */
export type CursorRuntime = Runtime & Required<Pick<Runtime, "installation" | "listModels" | "login" | "logout" | "authStatus" | "refusedSessionOptions">>;

/**
 * Cursor, embedded through its official SDK (`@cursor/sdk`). It is not in
 * `defaultRuntimes`, because the SDK is the host's to install and hand over;
 * a host that wants cursor adds `createCursorRuntime(...)` to its own
 * registry (docs/design/capabilities.md#a-runtimes-own-settings).
 *
 * Two execution modes (docs/runtimes/cursor.md#execution-modes):
 * - `{ sdk }` (the default, `execution: "in_process"`): the agent runs in
 *   this process, the way pi does. Its tools inherit the host's whole
 *   environment, so `SessionOptions.env` is refused, and an SDK crash is the
 *   host's crash.
 * - `{ execution: "subprocess", sdkModule }`: each session runs the SDK in
 *   its own Node child (`process.execPath`), whose environment is
 *   `SessionOptions.env` over the host's (`envBase: "inherit"`, the default)
 *   or over nothing (`envBase: "clean"`); a child that exits is recorded as
 *   `exited`, and a child whose host is gone, SIGKILL included, ends itself
 *   and what it started, as far as docs/runtimes/cursor.md#execution-modes
 *   says per platform. Model listing, login, logout and the status each run in a
 *   one-shot child and take `env` the same way.
 *
 * Account usage is absent: the SDK's usage call is not available to every
 * account (`feature_unavailable`, probed 2026-10-03), and each run reports
 * its own tokens anyway. Login, logout and the status are the SDK's own
 * `Cursor.auth`.
 */
export function createCursorRuntime(options: CursorRuntimeOptions): CursorRuntime {
  if (options.execution === "subprocess") {
    return cursorRuntime(subprocessAccess(options.sdkModule, options.envBase));
  }
  return cursorRuntime(inProcessAccess(options.sdk, true));
}

function cursorRuntime(access: CursorSdkAccess): CursorRuntime {
  const definition = {
    id: "cursor",
    refusedSessionOptions: access.refusedSessionOptions,
    brand: runtimeBrands.cursor,
    manualCompaction: { kind: "supported", activeTurn: "reject" },
    installation: cursorInstallationFor(process.platform, process.arch, access.execution),
    listModels: cursorListModelsWith(access),
    login: cursorLoginWith(access),
    logout: cursorLogoutWith(access),
    authStatus: cursorAuthStatusWith(access),
    session: cursorSessionWith(access),
  } as const;
  return defineRuntime(definition, access.execution === "subprocess" ? { execution: "process" } : { execution: "in_process" });
}

export { projectCursorModels } from "./list-models.js";
export { cursorNativeEnvironment } from "./native-environment.js";
