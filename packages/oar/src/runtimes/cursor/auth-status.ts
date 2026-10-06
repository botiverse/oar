import type { AuthStatus, AuthStatusReader, LoginAccount } from "../../contracts/login.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord } from "../../shared/json.js";
import { errorMessage, LoginSecrets } from "../../shared/login.js";
import { loadedSdk, type CursorAuth, type CursorSdk } from "./sdk.js";

const STATUS_TIMEOUT_MS = 20_000;
const STATUS_SOURCE = "Cursor.auth.status";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * `Cursor.auth.status()` (SDK 1.0.35) reads the stored login
 * (`~/.cursor/sdk/auth.json`) and answers `{ status: "logged-out" }`, also
 * for a key past its expiry, or `{ status: "logged-in", backendUrl, email?,
 * apiKeyExpiresAtMs? }`; it never returns the key. `CURSOR_API_KEY` is not
 * part of it.
 */
export function projectCursorAuthStatus(status: unknown): AuthStatus {
  const record = asRecord(status);
  if (record?.status === "logged-out") {
    return { kind: "logged_out", source: STATUS_SOURCE };
  }
  if (record?.status !== "logged-in") {
    return { kind: "unknown", detail: "Cursor.auth.status gave an answer oar cannot read", source: STATUS_SOURCE };
  }
  const email = text(record.email);
  const expiresMs = asNumber(record.apiKeyExpiresAtMs);
  const expiresAt = expiresMs === null ? null : utcInstantFromDate(new Date(expiresMs));
  const account: LoginAccount = {
    ...(email === undefined ? {} : { email }),
    ...(expiresAt === null ? {} : { expiresAt }),
  };
  return { kind: "logged_in", ...(Object.keys(account).length === 0 ? {} : { account }), source: STATUS_SOURCE };
}

/** `Cursor.auth.status()` within `timeoutMs`; a failure, or no answer in time, is `unknown`. */
export async function readCursorAuthStatus(auth: CursorAuth, timeoutMs = STATUS_TIMEOUT_MS): Promise<AuthStatus> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(new Error(`Cursor.auth.status did not answer within ${String(timeoutMs)} ms`));
  }, timeoutMs);
  timer.unref();
  try {
    const status = await Promise.race([auth.status(), deadline.promise]);
    return projectCursorAuthStatus(status);
  } catch (error) {
    return { kind: "unknown", detail: new LoginSecrets().line(errorMessage(error)), source: STATUS_SOURCE };
  } finally {
    clearTimeout(timer);
  }
}

/** Read only: asks the SDK's `Cursor.auth.status`, never a login flow, and returns no key. */
export function cursorAuthStatusWith(load: () => Promise<CursorSdk>): AuthStatusReader {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unknown", detail: "cursor's sign-in status needs the bundled @cursor/sdk" };
    }
    const sdk = await loadedSdk(load);
    if ("failed" in sdk) {
      return { kind: "unknown", detail: new LoginSecrets().line(sdk.failed) };
    }
    const { auth } = sdk.Cursor;
    if (auth === undefined) {
      return { kind: "unknown", detail: "this @cursor/sdk has no Cursor.auth; OAR needs 1.0.35" };
    }
    const status = await readCursorAuthStatus(auth, options.timeoutMs);
    return status;
  };
}
