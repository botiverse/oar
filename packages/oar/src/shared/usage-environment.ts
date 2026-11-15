import { UnsupportedOptionError } from "../contracts/errors.js";
import type { SessionOptions } from "../contracts/session-options.js";
import { environmentValue, sessionEnvironment } from "./environment.js";

const httpVariables = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_TLS_REJECT_UNAUTHORIZED",
] as const;

/**
 * The environment an account-usage reader resolves the runtime's paths and
 * credentials in. Its HTTP runs in the host process, which an overlay cannot
 * change, so an overlay that changes the host's HTTP/TLS variables is refused
 * before any process or request ([usage environment](../../../../docs/spec/account-usage.md#environment)).
 */
export function accountUsageEnvironment(runtime: string, overlay: SessionOptions["env"]): NodeJS.ProcessEnv {
  const environment = sessionEnvironment(overlay);
  const changed = Object.keys(overlay ?? {}).filter((name) => {
    const affectsHttp = httpVariables.some((variable) => process.platform === "win32"
      ? variable.toUpperCase() === name.toUpperCase() : variable === name);
    return affectsHttp && environmentValue(environment, name) !== environmentValue(process.env, name);
  });
  if (changed.length > 0) {
    throw new UnsupportedOptionError("env", `${runtime} account usage sends HTTP from the host process and cannot isolate: ${changed.join(", ")}`);
  }
  return environment;
}
