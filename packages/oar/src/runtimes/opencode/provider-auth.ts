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
   * Bound for each operation: starting `opencode serve` until its
   * integrations are loaded, and each request (default 30 s). A login's wait
   * for the person uses the same value when given, else 10 minutes (OpenCode
   * 2.2.7's own attempts expire after 600 s, xAI's after 1800 s).
   */
  readonly timeoutMs?: number;
}

/**
 * A {@link ProviderAuthFacade} over OpenCode 2's integrations. It owns one
 * `opencode serve` process, started on first use and stopped five seconds
 * after the last operation ends; `close()` stops it at once. An unclosed
 * facade never keeps its server longer than that idle period.
 */
export interface OpencodeProviderAuth extends ProviderAuthFacade {
  /** Stop the owned `opencode serve` now; a later operation starts a new one. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 600_000;
const IDLE_MS = 5000;

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
    loginTimeoutMs: options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    idleMs: IDLE_MS,
    pollMs: 100,
    statusPollMs: 1000,
  });
}
