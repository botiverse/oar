import { withQueryDeadline } from "../../shared/executable/query.js";
import type { SessionOptions } from "../../contracts/session-options.js";
import type { AccountUsageReauthReason, AccountUsageUnsupportedReason } from "../../contracts/account-usage.js";
import { startAppServerClient, type AppServerClient, type RpcOutcome } from "./app-server-client.js";
import { asRecord } from "../../shared/json.js";

export type ReadOutcome =
  | { readonly kind: "ok"; readonly result: unknown; readonly email: string | undefined }
  | { readonly kind: "reauth_required"; readonly reason: AccountUsageReauthReason }
  | { readonly kind: "unsupported"; readonly reason: AccountUsageUnsupportedReason }
  | { readonly kind: "error"; readonly cause?: unknown };

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

async function request(
  client: AppServerClient,
  call: AccountCall,
  signal: AbortSignal,
  onSettled: (outcome: RpcOutcome) => void,
): Promise<unknown> {
  signal.throwIfAborted();
  const state: { outcome?: RpcOutcome } = {};
  const record = (outcome: RpcOutcome): void => {
    state.outcome = outcome;
    onSettled(outcome);
  };
  try {
    return await client.request(call.method, call.params, record);
  } catch (error) {
    if (call.legacyParams === undefined || state.outcome?.kind === "exited" || !(error instanceof Error) || !/expected unit/iu.test(error.message)) {
      throw error;
    }
    signal.throwIfAborted();
    return client.request(call.method, call.legacyParams, record);
  }
}

function classifyAccountError(call: AccountCall, error: unknown, outcome: RpcOutcome | undefined): ReadOutcome {
  // Never classify process exit/crash stderr as auth or unsupported.
  if (outcome?.kind === "exited") {
    return { kind: "error", cause: error };
  }
  const native = outcome?.kind === "error" ? outcome.native : undefined;
  const nativeCode = typeof native?.code === "number" ? native.code : undefined;
  const message = typeof native?.message === "string" ? native.message : (error instanceof Error ? error.message : "");
  if (/chatgpt authentication required for rate limit reset/iu.test(message)) {
    return { kind: "unsupported", reason: "unsupported_auth_mode" };
  }
  // Only matches the native JSON-RPC error message of `call.method` itself
  // (never process-exit stderr or `initialize`, which are ruled out above).
  if (/authentication required/iu.test(message)) {
    return { kind: "reauth_required", reason: "not_authenticated" };
  }
  // Codex answers a method it predates with JSON-RPC -32601 or `unknown variant` naming the method.
  if (nativeCode === -32_601 || /\bmethod not found\b/iu.test(message) || message.includes(`unknown variant \`${call.method}\``)) {
    return { kind: "unsupported", reason: "endpoint_unavailable" };
  }
  return { kind: "error", cause: error };
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
  const state: { inAccountCall: boolean; aborted: boolean; callOutcome?: RpcOutcome } = {
    inAccountCall: false,
    aborted: false,
  };
  try {
    return await withQueryDeadline("Codex account request", timeoutMs, async (signal, own): Promise<ReadOutcome> => {
      signal.addEventListener("abort", () => { state.aborted = true; }, { once: true });
      const client = own(startClient(command, env));
      await client.request("initialize", {
        clientInfo: { name: "oar", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      });
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      if (isNonSubscriptionAccount(account)) {
        return { kind: "unsupported", reason: "unsupported_auth_mode" };
      }

      state.inAccountCall = true;
      const result = await request(client, call, signal, (outcome) => { state.callOutcome = outcome; });
      return { kind: "ok", result, email: accountEmail(account) };
    });
  } catch (error) {
    if (error instanceof RangeError) { throw error; }
    if (!state.inAccountCall || state.aborted) { return { kind: "error", cause: error }; }
    return classifyAccountError(call, error, state.callOutcome);
  }
}
