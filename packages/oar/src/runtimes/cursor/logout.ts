import type { RuntimeLogout } from "../../contracts/login.js";
import { errorMessage, LoginSecrets } from "../../shared/login.js";
import { confirmedLogout, logoutTimedOut, type NativeLogout } from "../../shared/logout.js";
import { readCursorAuthStatus } from "./auth-status.js";
import { loadedSdk, type CursorSdk } from "./sdk.js";

/*
 * `Cursor.auth.logout(options?: { store? })` (@cursor/sdk 1.0.36, read in
 * its bundle, `dist/esm/index.js`, and `dist/esm/auth/login.d.ts`
 * `sdkLogout`; 1.0.35 has the same): with no `store` it runs the SDK's own
 * `new FileCredentialStore().clear()`, which removes
 * `~/.cursor/sdk/auth.json` (`rm` with `force`, so a missing file is no
 * error), then drops the SDK's in-process cache of the stored key, and
 * resolves. It makes no request: "Local-only: the minted key stays valid
 * until its expiry unless revoked from the dashboard's API-keys page." The
 * SDK has no call that revokes it. `CURSOR_API_KEY` is not touched, and
 * `Cursor.auth.status` does not read it.
 */
const LOGOUT_CALL = "Cursor.auth.logout";
/** A local file removal. */
const LOGOUT_TIMEOUT_MS = 20_000;

/** The SDK's logout within `timeoutMs`; past it OAR stops waiting (a local removal it cannot stop). */
async function sdkLogout(logout: () => Promise<void>, timeoutMs: number): Promise<NativeLogout> {
  const deadline = Promise.withResolvers<"timed_out">();
  const timer = setTimeout(() => {
    deadline.resolve("timed_out");
  }, timeoutMs);
  timer.unref();
  try {
    const ended = await Promise.race([logout(), deadline.promise]);
    return ended === "timed_out" ? logoutTimedOut(LOGOUT_CALL, timeoutMs) : { kind: "done" };
  } catch (error) {
    return { kind: "failed", reason: "rejected", detail: new LoginSecrets().line(errorMessage(error)) };
  } finally {
    clearTimeout(timer);
  }
}

/** Signs cursor out with the SDK's own `Cursor.auth.logout`; `Cursor.auth.status` decides. */
export function cursorLogoutWith(load: () => Promise<CursorSdk>): RuntimeLogout {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "unsupported_installation", detail: "cursor signs out through the bundled @cursor/sdk" };
    }
    const sdk = await loadedSdk(load);
    if ("failed" in sdk) {
      return { kind: "failed", reason: "process_failed", detail: new LoginSecrets().line(sdk.failed) };
    }
    const { auth } = sdk.Cursor;
    if (auth?.logout === undefined) {
      return { kind: "unsupported", reason: "version_unsupported", detail: "@cursor/sdk 1.0.36 is required; this one has no Cursor.auth.logout" };
    }
    // With no store: the SDK's own default, the file `status()` reads.
    const native = await sdkLogout(async () => {
      await auth.logout?.();
    }, options.timeoutMs ?? LOGOUT_TIMEOUT_MS);
    return confirmedLogout(native, await readCursorAuthStatus(auth), LOGOUT_CALL);
  };
}
