import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginAccount } from "../../contracts/login.js";
import { runExecutable } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { claudeEnv } from "./environment.js";

const STATUS_TIMEOUT_MS = 20_000;
const STATUS_SOURCE = "claude auth status --json";


function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `claude auth status --json`: `{ loggedIn, authMethod, email?, subscriptionType?, ... }`, exit 0 logged in, 1 logged out. */
export function projectClaudeAuthStatus(stdout: string): AuthStatus {
  const status = asRecord(parseJson(stdout));
  if (status === null || typeof status.loggedIn !== "boolean") {
    return { kind: "unknown", detail: "claude auth status gave no loggedIn field", source: STATUS_SOURCE };
  }
  if (!status.loggedIn) {
    return { kind: "logged_out", source: STATUS_SOURCE };
  }
  const email = text(status.email);
  const plan = text(status.subscriptionType);
  const method = text(status.authMethod);
  const account: LoginAccount = {
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
    ...(method === undefined ? {} : { method }),
  };
  return { kind: "logged_in", ...(Object.keys(account).length === 0 ? {} : { account }), source: STATUS_SOURCE };
}

/** A status read, with what claude names as an API key's source (`ANTHROPIC_API_KEY`, `apiKeyHelper`), which `AuthStatus` has no field for. */
export interface ClaudeAuthRead {
  readonly status: AuthStatus;
  readonly apiKeySource?: string;
}

/** `signal` (internal: the login's own) stops the query; the answer is then `unknown`. */
export async function readClaudeAuthStatus(
  installation: AvailableInstallation,
  options: AuthStatusOptions & { readonly signal?: AbortSignal } = {},
): Promise<ClaudeAuthRead> {
  if (installation.via !== "executable") {
    return { status: { kind: "unknown", detail: "not a machine-installed executable" } };
  }
  const result = await runExecutable(installation.command, ["auth", "status", "--json"], {
    env: claudeEnv(),
    timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // Exit 0 logged in, 1 logged out; anything else (a timeout, a crash, an abort) is no answer.
  if (!result.ok && result.exitCode !== 1) {
    return { status: { kind: "unknown", detail: `claude auth status ended without an answer (exit ${String(result.exitCode)})`, source: STATUS_SOURCE } };
  }
  const status = projectClaudeAuthStatus(result.stdout);
  const apiKeySource = status.kind === "logged_in" ? text(asRecord(parseJson(result.stdout))?.apiKeySource) : undefined;
  return { status, ...(apiKeySource === undefined ? {} : { apiKeySource }) };
}

export async function claudeAuthStatus(
  installation: AvailableInstallation,
  options: AuthStatusOptions & { readonly signal?: AbortSignal } = {},
): Promise<AuthStatus> {
  const { status } = await readClaudeAuthStatus(installation, options);
  return status;
}
