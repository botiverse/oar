import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginOptions, LoginResult, LogoutOptions, LogoutResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";
import { loginBounds, loginExecutable, stoppedResult } from "../../shared/login.js";

/*
 * Factory droid's sign-in lives on its own ACP entry, `droid exec
 * --output-format acp` (droid 1.12.1; docs/runtimes/factory.md#login): its
 * stream-jsonrpc protocol has no login, status or logout method. There:
 * - `initialize` advertises `authMethods` `device-pairing` and
 *   `factory-api-key` and `agentCapabilities.auth` `{ logout, status }`;
 * - `auth/status` answers `{ state: "unauthenticated" }`, or
 *   `{ state: "authenticated", accounts: [{ label, active }] }`. With
 *   `FACTORY_API_KEY` set it answers authenticated with the label
 *   "Factory API key" without checking the key;
 * - `authenticate { methodId: "device-pairing" }` from a client declaring
 *   `clientCapabilities.elicitation.url` sends `elicitation/create { mode:
 *   "url", url }` (Factory's device page with the code in it); after an
 *   `accept` droid polls until the person confirms, stores the login and
 *   answers the authenticate. A decline ends it with -32000 "Sign-in was
 *   cancelled";
 * - `logout` clears droid's stored login.
 * droid opens no browser itself on this path. OAR never reads or writes the credential.
 */
const ACP_ARGS = ["exec", "--output-format", "acp"] as const;
const SOURCE = "droid exec --output-format acp: auth/status";
const API_KEY_LABEL = "Factory API key";
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const QUERY_TIMEOUT_MS = 30_000;

/** One line of droid's own words, without any URL (the device page carries the pairing code). */
function safeDetail(text: string): string {
  return text.replaceAll(/https?:\/\/\S+/gu, "<url>").split("\n")[0] ?? text;
}

interface AcpCall {
  request(method: string, params: JsonRecord): Promise<{ readonly result?: JsonRecord; readonly error?: JsonRecord }>;
}

/** One droid ACP process for one account operation, killed afterwards. Requests from droid go to `onRequest`; anything else is refused. */
async function withDroidAcp<T>(command: string, env: NodeJS.ProcessEnv, onRequest: (method: string, params: JsonRecord) => JsonRecord | null, run: (call: AcpCall, exited: Promise<number | null>) => Promise<T>): Promise<T> {
  const child: LineProcess = spawnLineProcess(command, [...ACP_ARGS], { env, inheritStderr: false, killTree: true });
  // oxlint-disable-next-line promise/prefer-await-to-then -- spawn failure is observed through the pending requests.
  void child.spawned.catch(() => {});
  const pending = new Map<number, (reply: { readonly result?: JsonRecord; readonly error?: JsonRecord }) => void>();
  let next = 1;
  const write = (message: JsonRecord): void => { child.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    if (typeof message.method === "string" && message.id !== undefined) {
      const result = onRequest(message.method, asRecord(message.params) ?? {});
      write(result === null ? { id: message.id, error: { code: -32_601, message: "not handled" } } : { id: message.id, result });
      return;
    }
    if (typeof message.id === "number") {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle?.({ ...(asRecord(message.result) === null ? {} : { result: asRecord(message.result) ?? {} }), ...(asRecord(message.error) === null ? {} : { error: asRecord(message.error) ?? {} }) });
    }
  });
  child.onExit(() => { for (const settle of pending.values()) { settle({ error: { message: "droid exited" } }); } pending.clear(); });
  try {
    return await run({
      async request(method, params) {
        const id = next;
        next += 1;
        const { promise, resolve } = Promise.withResolvers<{ readonly result?: JsonRecord; readonly error?: JsonRecord }>();
        pending.set(id, resolve);
        write({ id, method, params });
        const reply = await promise;
        return reply;
      },
    }, child.exited);
  } finally { child.kill(); await child.exited; }
}

const initializeParams = (elicitation: boolean): JsonRecord => ({
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(elicitation ? { elicitation: { url: {} } } : {}) },
  clientInfo: { name: "oar", version: "0.0.0" },
});

/** droid's `auth/status` answer as OAR's status. An API key droid reports without checking it is not a confirmed login. */
export function projectFactoryAuthStatus(result: JsonRecord | undefined): AuthStatus {
  const state = result?.state;
  if (state === "unauthenticated") { return { kind: "logged_out", source: SOURCE }; }
  if (state !== "authenticated") { return { kind: "unknown", source: SOURCE, detail: `droid reported auth state ${JSON.stringify(state ?? null)}` }; }
  const active = asRecordList(result?.accounts).find(account => account.active === true);
  if (active?.label === API_KEY_LABEL) {
    return { kind: "unknown", source: SOURCE, configured: ["FACTORY_API_KEY"],
      detail: "FACTORY_API_KEY is set; droid uses it instead of any stored login and reports it without checking it" };
  }
  return { kind: "logged_in", source: SOURCE, account: { credential: "account" } };
}

async function statusQuery(call: AcpCall): Promise<AuthStatus> {
  const status = await call.request("auth/status", {});
  return status.error === undefined ? projectFactoryAuthStatus(status.result) : { kind: "unknown", source: SOURCE, detail: "droid auth/status failed" };
}

async function readStatus(call: AcpCall): Promise<AuthStatus> {
  const initialized = await call.request("initialize", initializeParams(false));
  if (asRecord(asRecord(asRecord(initialized.result)?.agentCapabilities)?.auth)?.status === undefined) {
    return { kind: "unknown", source: SOURCE, detail: "this droid declares no auth/status" };
  }
  const status = await statusQuery(call);
  return status;
}

async function bounded<T>(timeoutMs: number, fallback: T, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const bounds = loginBounds(signal, timeoutMs);
  try { return await Promise.race([run(), (async (): Promise<T> => { await bounds.stopped; return fallback; })()]); }
  finally { bounds.dispose(); }
}

/** Whether droid is signed in, by its own ACP `auth/status`. */
export async function factoryAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions & { readonly signal?: AbortSignal } = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  try {
    return await withDroidAcp(installation.command, sessionEnvironment(options.env), () => null, async (call) => {
      const status = await bounded<AuthStatus>(timeoutMs, { kind: "unknown", source: SOURCE, detail: "droid auth status timed out" }, options.signal, async () => { const read = await readStatus(call); return read; });
      return status;
    });
  } catch { return { kind: "unknown", source: SOURCE, detail: "droid auth status could not run" }; }
}

/** Signs droid in through its device-pairing flow: the URL reaches the host as an `auth_url` event. */
export async function factoryLogin(installation: AvailableInstallation, interaction: ProviderLoginInteraction, options: LoginOptions = {}): Promise<LoginResult> {
  const env = sessionEnvironment(options.env);
  const target = loginExecutable(installation, "Factory droid", undefined, env);
  if (target.kind === "settled") { return target.result; }
  if (interaction.signal?.aborted === true) { return { kind: "cancelled" }; }
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const bounds = loginBounds(interaction.signal, timeoutMs);
  let failedInteraction = false;
  try {
    return await withDroidAcp(target.installation.command, env, (method, params) => {
      if (method !== "elicitation/create" || params.mode !== "url" || typeof params.url !== "string") { return null; }
      try {
        interaction.onEvent({ kind: "auth_url", url: params.url, ...(typeof params.message === "string" ? { instructions: params.message } : {}) });
      } catch {
        failedInteraction = true;
        return { action: "decline" };
      }
      return { action: "accept" };
    }, async (call, exited) => {
      const flow = async (): Promise<LoginResult> => {
        const initialized = await call.request("initialize", initializeParams(true));
        if (!asRecordList(asRecord(initialized.result)?.authMethods).some(entry => entry.id === "device-pairing")) {
          return { kind: "failed", reason: "process_failed", detail: "this droid offers no device-pairing sign-in" };
        }
        const answer = await call.request("authenticate", { methodId: "device-pairing" });
        if (failedInteraction) { return { kind: "failed", reason: "interaction_failed", detail: "Could not present the Factory sign-in link" }; }
        if (answer.error !== undefined) {
          return { kind: "failed", reason: "rejected", detail: safeDetail(typeof answer.error.message === "string" ? answer.error.message : "droid sign-in failed") };
        }
        // droid answered success: it has stored the login, so its own status decides from here.
        const status = interaction.signal?.aborted === true ? null : await statusQuery(call).catch(() => null);
        if (status?.kind === "logged_out") { return { kind: "failed", reason: "not_logged_in", detail: "droid reported sign-in success, yet its auth/status reads unauthenticated" }; }
        return status?.kind === "logged_in" && status.account !== undefined ? { kind: "logged_in", account: status.account } : { kind: "logged_in" };
      };
      const ended = async (): Promise<LoginResult> => { await exited; return { kind: "failed", reason: "process_failed", detail: "droid ended before the sign-in finished" }; };
      const stopped = async (): Promise<LoginResult> => stoppedResult(await bounds.stopped, timeoutMs);
      const result = await Promise.race([flow(), ended(), stopped()]);
      return result;
    });
  } catch { return { kind: "failed", reason: "process_failed", detail: "droid sign-in could not start" }; }
  finally { bounds.dispose(); }
}

/** Signs droid out through its own ACP `logout`; its `auth/status` decides. */
export async function factoryLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const env = sessionEnvironment(options.env);
  const target = loginExecutable(installation, "Factory droid", undefined, env);
  if (target.kind === "settled") { return target.result; }
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  try {
    return await withDroidAcp(target.installation.command, env, () => null, async (call) => { const result = await bounded<LogoutResult>(timeoutMs,
      { kind: "failed", reason: "timed_out", detail: `droid logout did not finish within ${String(timeoutMs)} ms` }, undefined, async () => {
        const initialized = await call.request("initialize", initializeParams(false));
        if (asRecord(asRecord(asRecord(initialized.result)?.agentCapabilities)?.auth)?.logout === undefined) {
          return { kind: "failed", reason: "process_failed", detail: "this droid declares no logout" };
        }
        const answer = await call.request("logout", {});
        const status = await call.request("auth/status", {});
        const read = status.error === undefined ? projectFactoryAuthStatus(status.result) : null;
        if (read?.kind === "logged_out") { return { kind: "logged_out" }; }
        if (read?.kind === "unknown" && read.configured !== undefined) {
          return { kind: "failed", reason: "still_logged_in", detail: "FACTORY_API_KEY is set; droid keeps using it, and OAR does not touch the environment" };
        }
        if (read?.kind === "logged_in") { return { kind: "failed", reason: "still_logged_in", detail: "droid auth/status still reads authenticated after its logout" }; }
        return answer.error === undefined ? { kind: "logged_out" }
          : { kind: "failed", reason: "rejected", detail: safeDetail(typeof answer.error.message === "string" ? answer.error.message : "droid logout failed") };
      }); return result; });
  } catch { return { kind: "failed", reason: "process_failed", detail: "droid logout could not start" }; }
}
