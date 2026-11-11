import type { AvailableInstallation } from "../../contracts/installation.js";
import type { ProviderAuthFacade } from "../../contracts/provider-auth.js";
import type { SessionOptions } from "../../contracts/session-options.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { OpencodeProviderAuthError } from "./provider-auth-error.js";
import { opencodeMajor } from "./version.js";

export { OpencodeProviderAuthError, type OpencodeProviderAuthErrorKind } from "./provider-auth-error.js";

export interface OpencodeProviderAuthOptions {
  /** Same overlay as sessions: strings override, null removes, and the host is untouched. */
  readonly env?: SessionOptions["env"];
  /**
   * One budget for starting `opencode serve` until its integrations are
   * loaded, and the bound for each request (default 30 s).
   */
  readonly timeoutMs?: number;
  /**
   * How long a login waits for the person to finish signing in (default
   * 10 minutes; OpenCode 2.2.7's own attempts expire after 600 s, xAI's after
   * 1800 s).
   */
  readonly loginTimeoutMs?: number;
  /** How long the server stays up after the last operation ends (default 5 s). */
  readonly idleMs?: number;
  /**
   * `"refuse"`: an OAuth attempt whose authorize URL returns the browser to
   * a loopback address (`localhost`, `127.0.0.1`, `::1`) on the machine
   * running `opencode serve`, and that takes no pasted code, is cancelled and
   * rejected with kind `loopback_required`, before any URL is shown. For a
   * host whose person signs in from another machine (a remote web UI).
   * Default `"allow"`.
   */
  readonly loopback?: "allow" | "refuse";
}

/**
 * A {@link ProviderAuthFacade} over OpenCode 2's integrations. It owns one
 * `opencode serve` process, started on first use and stopped `idleMs` after
 * the last operation ends; `close()` stops it at once. An unclosed facade
 * never keeps its server longer than that idle period, and the server also
 * stops when the host process dies, SIGKILL included.
 */
export interface OpencodeProviderAuth extends ProviderAuthFacade {
  /** Stop the owned `opencode serve` now; a later operation starts a new one. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_MS = 5000;

/**
 * Sign in to OpenCode 2's providers through OpenCode's own HTTP API
 * (`integration.*`, `credential.remove`). OAR never reads or writes
 * OpenCode's credential files. OpenCode 1 has no such API and is refused
 * with `OpencodeProviderAuthError` kind `version_unsupported`.
 */
export async function createOpencodeProviderAuth(
  installation: AvailableInstallation,
  options: OpencodeProviderAuthOptions = {},
): Promise<OpencodeProviderAuth> {
  if (installation.via !== "executable") {
    throw new OpencodeProviderAuthError("unsupported_installation", "OpenCode provider sign-in requires the opencode executable");
  }
  const env = sessionEnvironment(options.env);
  // OpenCode's own background service runs in the home directory; a
  // project directory could add integrations from its configuration.
  const cwd = environmentHome(env);
  if (await opencodeMajor(installation, { cwd, env: options.env ?? {} }) === 1) {
    throw new OpencodeProviderAuthError("version_unsupported",
      `OpenCode provider sign-in requires OpenCode 2 (@opencode/cli); this installation is OpenCode 1 (${installation.version ?? "version unknown"})`);
  }
  const { OpencodeProviderAuthFacade } = await import("./provider-auth-facade.js");
  return OpencodeProviderAuthFacade.create({
    command: installation.command,
    env,
    cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    loginTimeoutMs: options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
    loopback: options.loopback ?? "allow",
    pollMs: 100,
    statusPollMs: 1000,
  });
}
