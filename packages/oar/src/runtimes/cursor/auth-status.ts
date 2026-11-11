import { withQueryDeadline } from "../../shared/executable/query.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { AuthStatus, AuthStatusReader, LoginAccount } from "../../contracts/login.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord } from "../../shared/json.js";
import { errorMessage, LoginSecrets } from "../../shared/login.js";
import { environmentValue } from "../../shared/environment.js";
import { callRedaction, cursorSdkAccess, IN_PROCESS_ENV, withLease, type CursorSdkSource } from "./access.js";
import type { CursorAuth } from "./sdk.js";

const STATUS_TIMEOUT_MS = 20_000;
const STATUS_SOURCE = "Cursor.auth.status";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * `Cursor.auth.status()` (SDK 1.3.1) reads the stored login
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
    // This status describes the SDK's stored Cursor user key, not a
    // provider API key. The native account's Cursor plan funds its usage.
    credential: "api_key", metering: "plan",
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

/** Read only: asks the SDK's `Cursor.auth.status`, never a login flow, and returns no key. In subprocess mode it asks in a child with `env`. */
export function cursorAuthStatusWith(source: CursorSdkSource): AuthStatusReader {
  const access = cursorSdkAccess(source);
  const reader: AuthStatusReader = async (installation, options = {}) => {
    if (access.execution === "in_process" && options.env !== undefined && Object.keys(options.env).length > 0) {
      throw new UnsupportedOptionError("env", IN_PROCESS_ENV);
    }
    if (installation.via !== "bundled") {
      return { kind: "unknown", detail: "cursor's sign-in status needs the bundled @cursor/sdk" };
    }
    if (environmentValue(access.environment(options.env), "CURSOR_API_KEY") !== undefined) {
      return { kind: "unknown", configured: ["environment: CURSOR_API_KEY"], detail: "Sessions use CURSOR_API_KEY from the environment; Cursor.auth.status neither reads nor validates that key.", source: STATUS_SOURCE };
    }
    const result = await withQueryDeadline<AuthStatus>("Cursor auth status", options.timeoutMs ?? STATUS_TIMEOUT_MS, async (signal) => {
      const status = await withLease(access, options.env, async (sdk): Promise<AuthStatus> => {
        signal.throwIfAborted();
        const { auth } = sdk.Cursor;
        if (auth === undefined) {
          return { kind: "unknown", detail: "this @cursor/sdk has no Cursor.auth; OAR needs 1.3.1" };
        }
        const read = await readCursorAuthStatus(auth, options.timeoutMs);
        return read;
      });
      return "failed" in status ? { kind: "unknown", detail: new LoginSecrets().line(status.failed) } : status;
    }, { kind: "unknown", source: STATUS_SOURCE, detail: `Cursor.auth.status did not answer within ${String(options.timeoutMs ?? STATUS_TIMEOUT_MS)} ms` });
    // Details can carry the SDK's or the child's words: redacted with the call's credentials too.
    return callRedaction(options.env)(result);
  };
  // With no status options, the official SDK uses only its local file store.
  return Object.assign(reader, { localOnly: true as const });
}
