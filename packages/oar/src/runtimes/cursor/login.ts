import type { LoginResult, RuntimeLogin } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { errorMessage, LoginSecrets, loginBounds, stoppedResult, type LoginStop } from "../../shared/login.js";
import { readCursorAuthStatus } from "./auth-status.js";
import {
  loadedSdk,
  type CursorAuth,
  type CursorFileCredentialStore,
  type CursorLoginOptions,
  type CursorLoginStore,
  type CursorSdk,
} from "./sdk.js";

/*
 * `Cursor.auth.login()` (@cursor/sdk 1.0.35, read in its bundle,
 * `dist/esm/index.js`: `Ne.auth`, and `./src/agent/auth/login-flow.ts`):
 *
 * 1. It makes a PKCE handshake and calls `onLoginUrl(url)` at once; with
 *    `openBrowser: false` it opens no browser and prints nothing.
 * 2. It polls `POST /auth/poll` until the sign-in in the browser completes:
 *    150 attempts backing off from 1 s to 10 s, about 24 minutes. `signal`
 *    is checked before each attempt, goes to each fetch and wakes the
 *    backoff; an abort makes the login throw `Login was cancelled.`
 * 3. With the session token it mints a user API key (`createUserApiKey`,
 *    then `getMe` for the email). This step takes no signal.
 * 4. It saves `{ backendUrl, apiKey, apiKeyExpiresAtMs, email, ... }` to
 *    its `store`, whatever the signal says, and resolves.
 *
 * An abort after the poll is therefore ignored, and the key would still be
 * written. So OAR hands the login a store of its own, which passes the save
 * on to the SDK's own `FileCredentialStore` (`~/.cursor/sdk/auth.json`)
 * while the login still waits, and refuses it once OAR has ended the login
 * (cancelled, timed out, the caller failed). Whichever comes first decides:
 * a save that began stands and the result is `logged_in`; an end that came
 * first refuses every later save, and nothing is written. The SDK writes
 * nothing before that save, so the previous login stays as it was.
 */
/** Before the SDK's own poll gives up (about 24 minutes), so a deadline is `timed_out`, not the SDK's failure. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const URL_INSTRUCTIONS = "Open this URL on any device and sign in to Cursor; the login completes on its own.";
const ENV_KEY_NOTE = "CURSOR_API_KEY is set in this environment: cursor uses it, not the stored login, until it is unset.";

/** How `Cursor.auth.login` settled. */
type SdkOutcome =
  | { readonly kind: "resolved" }
  | { readonly kind: "rejected"; readonly error: unknown };

type Ending =
  | SdkOutcome
  | { readonly kind: "stop"; readonly stop: LoginStop }
  /** The caller's `onEvent` threw. */
  | { readonly kind: "interaction_failed"; readonly message: string };

interface FlowState {
  /**
   * `waiting` until the SDK saves its key or OAR ends the login, whichever
   * comes first: `storing` (the save began, the new login stands) or
   * `ended` (OAR settled; every later save is refused).
   */
  phase: "waiting" | "storing" | "ended";
}

/**
 * The SDK resolved: its key is saved. The status decides; when it cannot
 * answer (it failed, or the caller aborted) the result is `logged_in`
 * without an account.
 */
async function confirmed(auth: CursorAuth, signal: AbortSignal | undefined): Promise<LoginResult> {
  if (signal?.aborted === true) {
    return { kind: "logged_in" };
  }
  const status = await readCursorAuthStatus(auth);
  if (status.kind === "logged_out") {
    return { kind: "failed", reason: "not_logged_in", detail: "Cursor.auth.login stored a key, yet Cursor.auth.status says logged out" };
  }
  return status.kind === "logged_in" && status.account !== undefined ? { kind: "logged_in", account: status.account } : { kind: "logged_in" };
}

/** Runs the SDK's login; its result (the key among it) is dropped unread. */
async function sdkLogin(auth: CursorAuth, options: CursorLoginOptions): Promise<SdkOutcome> {
  try {
    await auth.login(options);
    return { kind: "resolved" };
  } catch (error) {
    return { kind: "rejected", error };
  }
}

async function runCursorLogin(
  auth: CursorAuth,
  file: CursorFileCredentialStore,
  interaction: ProviderLoginInteraction,
  timeoutMs: number,
): Promise<LoginResult> {
  const secrets = new LoginSecrets();
  const flow: FlowState = { phase: "waiting" };
  const sdkSignal = new AbortController();
  const interactionFailure = Promise.withResolvers<Ending>();
  /** Ends the login unless the SDK is already saving its key; true when it is ended. */
  const end = (): boolean => {
    if (flow.phase === "waiting") {
      flow.phase = "ended";
      sdkSignal.abort();
    }
    return flow.phase === "ended";
  };
  const store: CursorLoginStore = {
    async load() {
      // The login never reads its store.
      await Promise.resolve();
    },
    async save(credentials) {
      if (flow.phase !== "waiting") {
        throw new Error("the login ended before cursor stored its key; nothing was written");
      }
      flow.phase = "storing";
      // Unread, to the SDK's own store.
      await file.save(credentials);
    },
    async clear() {
      await Promise.resolve();
      throw new Error("oar's cursor login never clears the stored login");
    },
  };
  const onLoginUrl = (url: string): void => {
    if (flow.phase !== "waiting") {
      return;
    }
    try {
      interaction.onEvent({ kind: "auth_url", url, instructions: URL_INSTRUCTIONS });
      // The SDK prefers the variable over the stored login; its value is never read.
      if (process.env.CURSOR_API_KEY !== undefined) {
        interaction.onEvent({ kind: "info", message: ENV_KEY_NOTE });
      }
    } catch (error) {
      // A caller that cannot show the URL cannot finish the login.
      interactionFailure.resolve({ kind: "interaction_failed", message: errorMessage(error) });
    }
  };

  const bounds = loginBounds(interaction.signal, timeoutMs);
  try {
    // `onLoginUrl` runs before this returns: the SDK calls it before its first wait.
    const outcome = sdkLogin(auth, { openBrowser: false, onLoginUrl, signal: sdkSignal.signal, store });
    const ending = await Promise.race([
      outcome,
      // oxlint-disable-next-line promise/prefer-await-to-then -- the deadline and abort race the login
      bounds.stopped.then((stop): Ending => ({ kind: "stop", stop })),
      interactionFailure.promise,
    ]);
    if (ending.kind === "resolved") {
      return await confirmed(auth, interaction.signal);
    }
    if (ending.kind === "rejected") {
      return { kind: "failed", reason: "rejected", detail: secrets.line(errorMessage(ending.error)) };
    }
    if (end()) {
      return ending.kind === "stop"
        ? stoppedResult(ending.stop, timeoutMs)
        : { kind: "failed", reason: "interaction_failed", detail: secrets.line(ending.message) };
    }
    // The SDK was already saving its key: the new login stands unless the save fails.
    const stored = await outcome;
    return stored.kind === "resolved"
      ? await confirmed(auth, interaction.signal)
      : { kind: "failed", reason: "rejected", detail: secrets.line(errorMessage(stored.error)) };
  } finally {
    end();
    bounds.dispose();
  }
}

/** Signs cursor in with the SDK's own `Cursor.auth.login`, relaying its URL; the key goes to the SDK's store only. */
export function cursorLoginWith(load: () => Promise<CursorSdk>): RuntimeLogin {
  return async (installation, interaction, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "unsupported_installation", detail: "cursor signs in through the bundled @cursor/sdk" };
    }
    const aborted = (): boolean => interaction.signal?.aborted === true;
    if (aborted()) {
      return { kind: "cancelled" };
    }
    const sdk = await loadedSdk(load);
    if ("failed" in sdk) {
      return { kind: "failed", reason: "process_failed", detail: new LoginSecrets().line(sdk.failed) };
    }
    const { auth } = sdk.Cursor;
    const Store = sdk.FileCredentialStore;
    if (auth === undefined || Store === undefined) {
      return { kind: "unsupported", reason: "version_unsupported", detail: "@cursor/sdk 1.0.35 is required; this one has no Cursor.auth" };
    }
    // The caller may have aborted while the SDK loaded.
    if (aborted()) {
      return { kind: "cancelled" };
    }
    const result = await runCursorLogin(auth, new Store(), interaction, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    return result;
  };
}
