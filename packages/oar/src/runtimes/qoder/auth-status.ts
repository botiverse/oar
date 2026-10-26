import { sessionEnvironment } from "../../shared/environment.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions } from "../../contracts/login.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { runExecutable } from "../../shared/executable/index.js";

const SOURCE = "qodercli status --output json";

/** Status also carries identity and organization details. Only its explicit boolean leaves the private query. */
export function projectQoderAuthStatus(stdout: string): AuthStatus {
  const response = asRecord(parseJson(stdout));
  if (typeof response?.logged_in !== "boolean") {
    return { kind: "unknown", source: SOURCE, detail: "Qoder status gave no logged_in field" };
  }
  return { kind: response.logged_in ? "logged_in" : "logged_out", source: SOURCE };
}

export async function qoderAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const result = await runExecutable(installation.command, ["status", "--output", "json"], { env: sessionEnvironment(options.env), timeoutMs: options.timeoutMs ?? 30_000 });
  if (!result.ok) {
    return { kind: "unknown", source: SOURCE, detail: "Qoder account query ended without an answer" };
  }
  return projectQoderAuthStatus(result.stdout);
}
