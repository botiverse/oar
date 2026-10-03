import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  AuthStatus,
  AuthStatusOptions,
  LoginAccount,
  LoginOptions,
  LoginResult,
} from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { runExecutable } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import {
  exclusiveLogin,
  LoginSecrets,
  loginBounds,
  loginExecutable,
  stoppedResult,
  type LoginStop,
} from "../../shared/login.js";
import { startAppServerClient } from "./app-server-client.js";

/*
 * Codex signs in over its app-server (0.160.0 schema), never through
 * `codex login`, whose browser and device flows both clear the stored
 * credentials before the new sign-in completes:
 *
 *   → account/login/start { type: "chatgptDeviceCode" }
 *   ← { type: "chatgptDeviceCode", loginId, verificationUrl, userCode }
 *   ← account/login/completed { loginId, success, error }   (notification)
 *   → account/read {}  ← { account: { type, email, planType } | null, ... }
 *
 * The app-server polls on its own; the code expires after 15 minutes. The
 * `chatgptDeviceCode` login type arrived in 0.118.0. Device code sign-in
 * must be allowed in the ChatGPT account's security settings (a workspace
 * admin's permission for workspace accounts).
 */
const DEVICE_CODE_FLOOR = "0.118.0";
/** Past the code's 15 minutes, so codex reports the expiry itself. */
const LOGIN_TIMEOUT_MS = 16 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const STATUS_SOURCE = "codex login status";
const DEVICE_CODE_SETTING = "Device code sign-in must be allowed in your ChatGPT security settings (for a workspace account, by its admin).";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * `codex login status` prints to stderr and exits 0 when signed in
 * (`Logged in using ChatGPT`, or `Logged in using an API key - <masked>`),
 * 1 with `Not logged in` when signed out, and 1 with another message when
 * it cannot tell (an unreadable configuration or credential store).
 */
export function projectCodexLoginStatus(exitCode: number | null, output: string): AuthStatus {
  if (exitCode === 0) {
    const method = /Logged in using ChatGPT/u.test(output) ? "chatgpt" : (/Logged in using an API key/u.test(output) ? "apiKey" : undefined);
    return { kind: "signed_in", ...(method === undefined ? {} : { account: { method } }), source: STATUS_SOURCE };
  }
  if (exitCode === 1 && /^Not logged in\b/mu.test(output)) {
    return { kind: "signed_out", source: STATUS_SOURCE };
  }
  const line = output.trim().split(/\r?\n/u).at(-1) ?? "";
  return {
    kind: "unknown",
    detail: new LoginSecrets().redact(line === "" ? `exit ${String(exitCode)}` : line),
    source: STATUS_SOURCE,
  };
}

export async function codexAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") {
    return { kind: "unknown", detail: "not a machine-installed executable" };
  }
  const result = await runExecutable(installation.command, ["login", "status"], { timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS });
  return projectCodexLoginStatus(result.ok ? 0 : result.exitCode, `${result.stdout}\n${result.stderr}`);
}

/** `account/read` after the sign-in; null when codex reports no account. */
export function projectCodexAccount(result: unknown): LoginAccount | null {
  const account = asRecord(asRecord(result)?.account);
  if (account === null) {
    return null;
  }
  const email = text(account.email);
  const plan = text(account.planType);
  const method = text(account.type);
  return {
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
    ...(method === undefined ? {} : { method }),
  };
}

type Completion =
  | { readonly kind: "completed"; readonly params: JsonRecord }
  | { readonly kind: "exited" };

async function runCodexLogin(command: string, interaction: ProviderLoginInteraction, timeoutMs: number): Promise<LoginResult> {
  const secrets = new LoginSecrets();
  const bounds = loginBounds(interaction.signal, timeoutMs);
  const client = startAppServerClient(command);
  const completion = Promise.withResolvers<Completion>();
  let loginId: string | undefined = undefined;
  let exited = false;
  let settled = false;
  client.onExit(() => {
    exited = true;
    completion.resolve({ kind: "exited" });
  });
  client.handle({
    onNotification(method, params) {
      const id = params.loginId;
      if (method === "account/login/completed" && loginId !== undefined && (id === undefined || id === null || id === loginId)) {
        completion.resolve({ kind: "completed", params });
      }
    },
    onServerRequest() {
      // A login asks the client nothing.
    },
  });

  const failure = (error: unknown): LoginResult => {
    const message = secrets.redact(error instanceof Error ? error.message : String(error));
    return exited
      ? { kind: "failed", reason: "process_failed", detail: message }
      : { kind: "failed", reason: "rejected", detail: message };
  };

  const flow = async (): Promise<LoginResult> => {
    try {
      await client.request("initialize", { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } });
      client.notify("initialized", {});
      const started = await client.request("account/login/start", { type: "chatgptDeviceCode" }, (outcome) => {
        // Set as the reply is read, before any notification after it.
        if (outcome.kind === "result") {
          loginId = text(outcome.result.loginId);
        }
      });
      const verificationUri = text(started.verificationUrl);
      const userCode = text(started.userCode);
      if (loginId === undefined || verificationUri === undefined || userCode === undefined) {
        return { kind: "failed", reason: "process_failed", detail: "codex answered account/login/start without a device code" };
      }
      if (!settled) {
        try {
          interaction.onEvent({ kind: "device_code", userCode, verificationUri });
          interaction.onEvent({ kind: "info", message: DEVICE_CODE_SETTING });
        } catch (error) {
          // A caller that cannot show the code cannot finish the login.
          return { kind: "failed", reason: "interaction_failed", detail: secrets.redact(error instanceof Error ? error.message : String(error)) };
        }
      }
      const done = await completion.promise;
      if (done.kind === "exited") {
        return { kind: "failed", reason: "process_failed", detail: "codex app-server exited before the sign-in completed" };
      }
      if (done.params.success !== true) {
        return { kind: "failed", reason: "rejected", detail: secrets.redact(text(done.params.error) ?? "codex reported that the sign-in failed") };
      }
      const account = projectCodexAccount(await client.request("account/read", {}));
      return account === null
        ? { kind: "failed", reason: "not_signed_in", detail: "codex reported success, yet account/read shows no account" }
        : { kind: "logged_in", ...(Object.keys(account).length === 0 ? {} : { account }) };
    } catch (error) {
      return failure(error);
    }
  };

  try {
    const ending = await Promise.race([
      flow(),
      // oxlint-disable-next-line promise/prefer-await-to-then -- the deadline and abort race the flow
      bounds.stopped.then((stop): LoginStop => stop),
    ]);
    settled = true;
    return typeof ending === "string" ? stoppedResult(ending, timeoutMs) : ending;
  } finally {
    settled = true;
    bounds.dispose();
    // The pending login lives in the app-server; stopping it (and its group) ends the polling.
    client.kill();
    await client.exited;
  }
}

/** Signs codex in with the app-server's ChatGPT device code flow, relaying the code and its URL. */
export async function codexLogin(
  installation: AvailableInstallation,
  interaction: ProviderLoginInteraction,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const target = loginExecutable(installation, "codex", DEVICE_CODE_FLOOR);
  if (target.kind === "unsupported") {
    return target.result;
  }
  if (interaction.signal?.aborted === true) {
    return { kind: "cancelled" };
  }
  const result = await exclusiveLogin("codex", async () => {
    const outcome = await runCodexLogin(target.installation.command, interaction, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    return outcome;
  });
  return result;
}
