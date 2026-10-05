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
  errorMessage,
  LoginSecrets,
  loginBounds,
  loginExecutable,
  stoppedResult,
  type LoginStop,
} from "../../shared/login.js";
import { startAppServerClient, type AppServerClient } from "./app-server-client.js";

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
 * The app-server polls on its own and writes the credential store only once
 * the new tokens are exchanged, so a failure, a cancel or the expiry leaves
 * the stored login untouched; the code expires after 15 minutes. The
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
 * `codex login status` prints to stderr and exits 0 when logged in
 * (`Logged in using ChatGPT`, or `Logged in using an API key - <masked>`),
 * 1 with `Not logged in` when logged out, and 1 with another message when
 * it cannot tell (an unreadable configuration or credential store).
 */
export function projectCodexLoginStatus(exitCode: number | null, output: string): AuthStatus {
  if (exitCode === 0) {
    const method = /Logged in using ChatGPT/u.test(output) ? "chatgpt" : (/Logged in using an API key/u.test(output) ? "apiKey" : undefined);
    return { kind: "logged_in", ...(method === undefined ? {} : { account: { method } }), source: STATUS_SOURCE };
  }
  if (exitCode === 1 && /^Not logged in\b/mu.test(output)) {
    return { kind: "logged_out", source: STATUS_SOURCE };
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
  | { readonly kind: "exited"; readonly code: number | null };

interface FlowState {
  /** Set as the start reply is read, before any notification after it. */
  loginId: string | undefined;
  /** Completions read before the start reply, held until its login id is known. */
  readonly early: JsonRecord[];
  exitCode: number | null | undefined;
  /** Ended: events are no longer shown. */
  settled: boolean;
  /** Started when codex reports success: the login is stored, so its account decides whatever ends the flow. */
  confirmation: Promise<LoginResult> | undefined;
}

/** `account/read` on the same app-server, bounded by the status deadline and the caller's abort; undefined when it gave no answer. */
async function readAccount(client: AppServerClient, signal: AbortSignal | undefined): Promise<unknown> {
  if (signal?.aborted === true) {
    return undefined;
  }
  const bounds = loginBounds(signal, STATUS_TIMEOUT_MS);
  try {
    const answer = await Promise.race([
      // oxlint-disable-next-line promise/prefer-await-to-then -- a late rejection (the app-server stopped) is no answer
      client.request("account/read", {}).catch((): undefined => undefined),
      // oxlint-disable-next-line promise/prefer-await-to-then -- the deadline and abort race the read
      bounds.stopped.then((): undefined => undefined),
    ]);
    return answer;
  } finally {
    bounds.dispose();
  }
}

/** After codex reported success: logged in, with the account when `account/read` names one. */
async function confirmed(client: AppServerClient, signal: AbortSignal | undefined): Promise<LoginResult> {
  const read = await readAccount(client, signal);
  if (read === undefined) {
    return { kind: "logged_in" };
  }
  const account = projectCodexAccount(read);
  return account === null
    ? { kind: "failed", reason: "not_logged_in", detail: "codex reported success, yet account/read shows no account" }
    : { kind: "logged_in", ...(Object.keys(account).length === 0 ? {} : { account }) };
}

function exitDetail(code: number | null | undefined): string {
  return `codex app-server exited${code === null || code === undefined ? "" : ` with code ${String(code)}`}`;
}

async function runCodexLogin(command: string, interaction: ProviderLoginInteraction, timeoutMs: number): Promise<LoginResult> {
  const secrets = new LoginSecrets();
  let client: AppServerClient | null = null;
  try {
    // Its stderr never reaches the host's, and a stop takes its Windows process tree too.
    client = startAppServerClient(command, undefined, {}, undefined, { inheritStderr: false, killTree: true });
  } catch (error) {
    return { kind: "failed", reason: "process_failed", detail: secrets.line(errorMessage(error)) };
  }
  const app = client;
  const completion = Promise.withResolvers<Completion>();
  const flow: FlowState = { loginId: undefined, early: [], exitCode: undefined, settled: false, confirmation: undefined };
  const ours = (params: JsonRecord): boolean => {
    const id = params.loginId;
    return id === undefined || id === null || id === flow.loginId;
  };
  const complete = (params: JsonRecord): void => {
    if (params.success === true) {
      flow.confirmation ??= confirmed(app, interaction.signal);
    }
    completion.resolve({ kind: "completed", params });
  };
  app.onExit((code) => {
    flow.exitCode = code;
    completion.resolve({ kind: "exited", code });
  });
  app.handle({
    onNotification(method, params) {
      if (method !== "account/login/completed") {
        return;
      }
      if (flow.loginId === undefined) {
        flow.early.push(params);
      } else if (ours(params)) {
        complete(params);
      }
    },
    onServerRequest() {
      // A login asks the client nothing.
    },
  });

  const run = async (): Promise<LoginResult> => {
    try {
      await app.spawned;
    } catch (error) {
      // An executable that cannot run (found, yet not startable) says so in Node's words.
      return { kind: "failed", reason: "process_failed", detail: secrets.line(errorMessage(error)) };
    }
    try {
      await app.request("initialize", { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } });
      app.notify("initialized", {});
      const started = await app.request("account/login/start", { type: "chatgptDeviceCode" }, (outcome) => {
        if (outcome.kind === "result") {
          flow.loginId = text(outcome.result.loginId);
          for (const params of flow.early.splice(0)) {
            if (ours(params)) {
              complete(params);
            }
          }
        }
      });
      const verificationUri = text(started.verificationUrl);
      const userCode = text(started.userCode);
      if (flow.loginId === undefined || verificationUri === undefined || userCode === undefined) {
        return { kind: "failed", reason: "process_failed", detail: "codex answered account/login/start without a device code" };
      }
      // A success that came before the start reply is final: nothing left to show the person.
      const early = flow.confirmation;
      if (early !== undefined) {
        return await early;
      }
      if (!flow.settled) {
        try {
          interaction.onEvent({ kind: "device_code", userCode, verificationUri });
          interaction.onEvent({ kind: "info", message: DEVICE_CODE_SETTING });
        } catch (error) {
          // A caller that cannot show the code cannot finish the login.
          return { kind: "failed", reason: "interaction_failed", detail: secrets.line(errorMessage(error)) };
        }
      }
      const done = await completion.promise;
      if (flow.confirmation !== undefined) {
        return await flow.confirmation;
      }
      if (done.kind === "exited") {
        return { kind: "failed", reason: "process_failed", detail: `${exitDetail(done.code)} before the sign-in completed` };
      }
      return { kind: "failed", reason: "rejected", detail: secrets.line(text(done.params.error) ?? "codex reported that the sign-in failed") };
    } catch (error) {
      // An exit's error carries the app-server's stderr tail: only the exit is reported, never that tail.
      return flow.exitCode === undefined
        ? { kind: "failed", reason: "rejected", detail: secrets.line(errorMessage(error)) }
        : { kind: "failed", reason: "process_failed", detail: exitDetail(flow.exitCode) };
    }
  };

  const bounds = loginBounds(interaction.signal, timeoutMs);
  try {
    const ending = await Promise.race([
      run(),
      // oxlint-disable-next-line promise/prefer-await-to-then -- the deadline and abort race the flow
      bounds.stopped.then((stop): LoginStop => stop),
    ]);
    flow.settled = true;
    if (typeof ending !== "string") {
      return ending;
    }
    // Codex reported success before the stop: the login is stored.
    return flow.confirmation === undefined ? stoppedResult(ending, timeoutMs) : await flow.confirmation;
  } finally {
    flow.settled = true;
    bounds.dispose();
    // The pending login lives in the app-server; stopping it (and its group or tree) ends the polling.
    app.kill();
    await app.exited;
  }
}

/** Signs codex in with the app-server's ChatGPT device code flow, relaying the code and its URL. */
export async function codexLogin(
  installation: AvailableInstallation,
  interaction: ProviderLoginInteraction,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const target = loginExecutable(installation, "codex", DEVICE_CODE_FLOOR);
  if (target.kind === "settled") {
    return target.result;
  }
  if (interaction.signal?.aborted === true) {
    return { kind: "cancelled" };
  }
  const result = await runCodexLogin(target.installation.command, interaction, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  return result;
}
