import type { SessionOptions } from "../../contracts/session-options.js";
import type { AccountUsageReauthReason, AccountUsageUnsupportedReason } from "../../contracts/account-usage.js";
import { startAppServerClient, type AppServerClient } from "./app-server-client.js";
import { asRecord } from "../../shared/json.js";

export type ReadOutcome =
  | { readonly kind: "ok"; readonly result: unknown; readonly email: string | undefined }
  | { readonly kind: "reauth_required"; readonly reason: AccountUsageReauthReason }
  | { readonly kind: "unsupported"; readonly reason: AccountUsageUnsupportedReason }
  | { readonly kind: "error" };

export type StartAppServerClient = (command: string, env?: SessionOptions["env"]) => AppServerClient;

/**
 * One account request. `legacyParams` is sent instead when the app-server
 * refuses `params` as one older than its fields (`invalid type: map,
 * expected unit`, codex 0.131.0 for `account/rateLimits/read`).
 */
export interface AccountCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly legacyParams?: Record<string, unknown>;
}

async function request(client: AppServerClient, call: AccountCall): Promise<unknown> {
  try {
    return await client.request(call.method, call.params);
  } catch (error) {
    if (call.legacyParams === undefined || !(error instanceof Error) || !/expected unit/iu.test(error.message)) {
      throw error;
    }
    return client.request(call.method, call.legacyParams);
  }
}

/**
 * Native evidence from `account/read` on the same app-server session:
 *
 * ```json
 * { "account": { "type": "chatgpt", "email": "user@example.com", "planType": "pro" },
 *   "requiresOpenaiAuth": true }
 * ```
 *
 * Only a ChatGPT (subscription) login carries a meaningful account email; an
 * API-key account is dropped per the owner's `type === "chatgpt"` requirement.
 */
export function accountEmail(result: unknown): string | undefined {
  const account = asRecord(asRecord(result)?.account);
  if (account?.type !== "chatgpt" || typeof account.email !== "string") {
    return undefined;
  }
  return account.email;
}

/**
 * Codex exposes ChatGPT rate-limit windows only for a ChatGPT account. API-key
 * and provider-managed runtimes are valid, but have no subscription usage for
 * this capability to report.
 */
export function isNonSubscriptionAccount(result: unknown): boolean {
  const root = asRecord(result);
  const account = asRecord(root?.account);
  return account?.type === "apiKey"
    || account?.type === "amazonBedrock"
    || root?.requiresOpenaiAuth === false;
}

/** One ChatGPT-account request on a fresh app-server, after `account/read` rules out other account modes. */
export async function callAppServer(
  command: string,
  timeoutMs: number,
  call: AccountCall,
  startClient: StartAppServerClient = startAppServerClient,
  env?: SessionOptions["env"],
): Promise<ReadOutcome> {
  const client = startClient(command, env);
  const deadline = setTimeout(() => {
    client.kill();
  }, timeoutMs);
  try {
    await client.request("initialize", {
      clientInfo: { name: "oar", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});

    // Read auth mode before the ChatGPT-only account endpoints. In API-key
    // mode that endpoint rejects with "ChatGPT authentication required" even
    // though Codex itself is correctly authenticated; treating that as expired
    // OAuth would tell the user to perform a login that cannot fix the state.
    let account: unknown = undefined;
    try {
      account = await client.request("account/read", {});
    } catch {
      // Older app-servers may not expose account/read. Preserve the existing
      // rate-limit read in that case instead of making identity mandatory.
    }
    if (isNonSubscriptionAccount(account)) {
      return { kind: "unsupported", reason: "unsupported_auth_mode" };
    }

    const result = await request(client, call);
    return { kind: "ok", result, email: accountEmail(account) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/chatgpt authentication required for rate limit reset/iu.test(message)) {
      return { kind: "unsupported", reason: "unsupported_auth_mode" };
    }
    if (/authentication required/iu.test(message)) {
      return { kind: "reauth_required", reason: "not_authenticated" };
    }
    // Codex answers a method it predates with `unknown variant` and the method name.
    if (/method not found|not supported/iu.test(message) || message.includes(`unknown variant \`${call.method}\``)) {
      return { kind: "unsupported", reason: "endpoint_unavailable" };
    }
    return { kind: "error" };
  } finally {
    clearTimeout(deadline);
    client.kill();
  }
}
