import { withQueryDeadline } from "../../shared/executable/query.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginAccount } from "../../contracts/login.js";
import { runExecutable } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { claudeAccountProfile, rememberedClaudeAccount } from "./last-account.js";
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
    ...(method === "claude.ai" ? { credential: "account", metering: "plan" } as const : {}),
    // A key can target a custom Anthropic-compatible provider; its billing
    // is not established by the native api_key status alone.
    ...(method === "api_key" ? { credential: "api_key" } as const : {}),
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
  const env = claudeEnv(options.env);
  const result = await runExecutable(installation.command, ["auth", "status", "--json"], {
    env,
    timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // Exit 0 logged in, 1 logged out; anything else (a timeout, a crash, an abort) is no answer.
  if (!result.ok && result.exitCode !== 1) {
    return { status: { kind: "unknown", detail: `claude auth status ended without an answer (exit ${String(result.exitCode)})`, source: STATUS_SOURCE } };
  }
  const parsed = asRecord(parseJson(result.stdout));
  let status = projectClaudeAuthStatus(result.stdout);
  if (status.kind === "logged_in" && status.account !== undefined && (status.account.method === "claude.ai" || status.account.plan !== undefined)) {
    const orgId = text(parsed?.orgId);
    const orgName = text(parsed?.orgName);
    const profile = await claudeAccountProfile(env, {
      ...(status.account.email === undefined ? {} : { email: status.account.email }),
      ...(orgId === undefined ? {} : { orgId }),
      ...(orgName === undefined ? {} : { orgName }),
    });
    if (profile.planDisplayName !== undefined || profile.accountId !== undefined) {
      status = {
        ...status,
        account: {
          ...status.account,
          ...(profile.planDisplayName === undefined ? {} : { plan: profile.planDisplayName }),
          ...(profile.accountId === undefined ? {} : { accountId: profile.accountId }),
        },
      };
    }
  }
  const apiKeySource = status.kind === "logged_in" ? text(parsed?.apiKeySource) : undefined;
  return { status, ...(apiKeySource === undefined ? {} : { apiKeySource }) };
}

export async function claudeAuthStatus(
  installation: AvailableInstallation,
  options: AuthStatusOptions = {},
): Promise<AuthStatus> {
  const result = await withQueryDeadline<AuthStatus>("Claude auth status", options.timeoutMs ?? STATUS_TIMEOUT_MS, async (signal) => {
    const { status } = await readClaudeAuthStatus(installation, { ...options, signal });
    if (status.kind !== "logged_out") { return status; }
    const lastAccount = await rememberedClaudeAccount(claudeEnv(options.env));
    return lastAccount === undefined ? status : { ...status, lastAccount };
  }, { kind: "unknown", source: STATUS_SOURCE, detail: "Claude auth status timed out" });
  return result;
}
