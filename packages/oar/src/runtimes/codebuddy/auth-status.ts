import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions } from "../../contracts/login.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { loginBounds } from "../../shared/login.js";
import { codebuddyAccountControl } from "./account-control.js";

const SOURCE = "codebuddy stream-json initialize.account";

/** Do not expose the account object: it contains the access token as well as account identity. */
export function projectCodebuddyAuthStatus(response: JsonRecord): AuthStatus {
  if (response.account === null) { return { kind: "logged_out", source: SOURCE }; }
  if (asRecord(response.account) !== null) { return { kind: "logged_in", source: SOURCE }; }
  return { kind: "unknown", source: SOURCE, detail: "CodeBuddy initialize gave no account state" };
}

export async function codebuddyAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}, signal?: AbortSignal): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const env = sessionEnvironment(options.env);
  if ((environmentValue(env, "CODEBUDDY_API_KEY") ?? "") !== "") {
    // Native initialize may synthesize an account from this key without validating it.
    return { kind: "unknown", source: SOURCE, configured: ["environment: CODEBUDDY_API_KEY"], detail: "CODEBUDDY_API_KEY is configured; the native account query does not validate this key or its provider endpoint." };
  }
  const bounds = loginBounds(signal, options.timeoutMs ?? 30_000);
  let client: ReturnType<typeof codebuddyAccountControl> | undefined = undefined;
  try {
    const control = codebuddyAccountControl(installation.command, env); client = control;
    const read = async (): Promise<AuthStatus> => projectCodebuddyAuthStatus(await control.request({ subtype: "initialize" }));
    const timeout = async (): Promise<AuthStatus> => { const stopped = await bounds.stopped; return { kind: "unknown", source: SOURCE, detail: stopped === "cancelled" ? "CodeBuddy account query cancelled" : "CodeBuddy account query timed out" }; };
    return await Promise.race([read(), timeout()]);
  } catch {
    // Process output and control errors can contain an account or a credential.
    return { kind: "unknown", source: SOURCE, detail: "CodeBuddy account query ended without an answer" };
  } finally {
    bounds.dispose(); client?.process.stop(); await client?.process.exited;
  }
}
