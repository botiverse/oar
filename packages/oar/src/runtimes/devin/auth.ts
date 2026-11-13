import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginAccount } from "../../contracts/login.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";

const SOURCE = "devin auth status";
const LOGGED_OUT = /^Not logged in\./mu;
const LOGGED_IN = /^Logged in(?:\s+\(via ([^)\r\n]+)\)|(\s+with provided API key))?\./mu;
const EMAIL_LINE = /^\s*Email:\s*(\S+)\s*$/mu;

/** Parse `devin auth status` stdout without retaining credential paths or tokens. */
export function parseDevinAuthStatus(stdout: string): AuthStatus {
  if (LOGGED_OUT.test(stdout)) {
    return {
      kind: "logged_out",
      source: SOURCE,
      detail: "Run `devin auth login` in a terminal or set WINDSURF_API_KEY.",
    };
  }
  const loggedIn = LOGGED_IN.exec(stdout);
  if (loggedIn !== null) {
    const rawMethod = loggedIn[1]?.trim();
    const method = rawMethod !== undefined && rawMethod.length > 0 ? rawMethod : undefined;
    const credential = loggedIn[2] === undefined ? undefined : "api_key";
    const email = EMAIL_LINE.exec(stdout)?.[1];
    const account: LoginAccount = {
      ...(email === undefined ? {} : { email }),
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
