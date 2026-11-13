import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginAccount } from "../../contracts/login.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";

const SOURCE = "devin auth status";
const LOGGED_OUT = /^Not logged in\./mu;
const FAILED_TO_LOAD = /^Failed to load credentials:/mu;
const LOGGED_IN = /^Logged in(?:\s+\(via ([^)\r\n]+)\))?\./mu;
const SERVER_AUTH_REJECTED = /^\s*Failed to fetch from server:\s*.*(?:authentication required|invalid api key)/imu;
const SERVER_UNVERIFIED = /^\s*(?:Failed to fetch from server|Unavailable):/mu;

/** Parse `devin auth status` stdout without retaining credential paths or tokens. */
export function parseDevinAuthStatus(stdout: string): AuthStatus {
  if (LOGGED_OUT.test(stdout)) {
    return {
      kind: "logged_out",
      source: SOURCE,
      detail: "Run `devin auth login` in a terminal or set WINDSURF_API_KEY.",
    };
  }
  if (FAILED_TO_LOAD.test(stdout)) {
    return {
      kind: "unknown",
      source: SOURCE,
      detail: "devin auth status reported unreadable stored credentials",
    };
  }
  const loggedIn = LOGGED_IN.exec(stdout);
  if (loggedIn !== null) {
    if (SERVER_AUTH_REJECTED.test(stdout)) {
      return {
        kind: "logged_out",
        source: SOURCE,
        detail: "Stored Devin credentials were rejected by the server. Run `devin auth logout` and `devin auth login` to re-authenticate.",
      };
    }
    if (SERVER_UNVERIFIED.test(stdout)) {
      return {
        kind: "unknown",
        source: SOURCE,
        configured: ["stored credentials"],
        detail: "devin auth status found stored credentials and could not verify them with the server",
      };
    }
    const rawMethod = loggedIn[1]?.trim();
    const method = rawMethod !== undefined && rawMethod.length > 0 ? rawMethod : undefined;
    const credential = method === "API key" ? "api_key" : undefined;
    const account: LoginAccount = {
      ...(method === undefined ? {} : { method }),
      ...(credential === undefined ? {} : { credential }),
    };
    return Object.keys(account).length > 0
      ? { kind: "logged_in", account, source: SOURCE }
      : { kind: "logged_in", source: SOURCE };
  }
  return {
    kind: "unknown",
    source: SOURCE,
    detail: "devin auth status ended without saying whether it is signed in",
  };
}

/** Read Devin auth status via `devin auth status`, flagging unvalidated `WINDSURF_API_KEY` overrides. */
export async function readDevinAuthStatus(
  installation: AvailableInstallation,
  options: AuthStatusOptions & { readonly signal?: AbortSignal } = {},
): Promise<AuthStatus> {
  if (installation.via !== "executable") {
    return { kind: "unknown", detail: "not a machine-installed executable" };
  }
  const env = sessionEnvironment(options.env);
  if ((environmentValue(env, "WINDSURF_API_KEY") ?? "") !== "") {
    return {
      kind: "unknown",
      source: SOURCE,
      configured: ["environment: WINDSURF_API_KEY"],
      detail: "WINDSURF_API_KEY is configured; devin auth status inspects stored login credentials and does not validate this environment key.",
    };
  }
  const result = await runExecutable(installation.command, ["auth", "status"], {
    env,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!result.ok) {
    return {
      kind: "unknown",
      source: SOURCE,
      detail: "devin auth status ended without saying whether it is signed in",
    };
  }
  return parseDevinAuthStatus(result.stdout);
}

/** Whether Devin is signed in, bounded by a query deadline (not declared localOnly). */
export async function devinAuthStatus(
  installation: AvailableInstallation,
  options: AuthStatusOptions = {},
): Promise<AuthStatus> {
  const status = await withQueryDeadline<AuthStatus>(
    "Devin auth status",
    options.timeoutMs ?? 30_000,
    async (signal) => {
      const read = await readDevinAuthStatus(installation, { ...options, signal });
      return read;
    },
    { kind: "unknown", source: SOURCE, detail: "Devin auth status timed out" },
  );
  return status;
}
