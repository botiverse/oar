import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions } from "../../contracts/login.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { readAntigravityAccount, rememberedAntigravityAccount } from "./account.js";
import { antigravityUsesDefaultState, ANTIGRAVITY_STATE_QUERY_UNAVAILABLE } from "./state-directory.js";
import { antigravityVersionPreflight } from "./version.js";

const SOURCE = "agy models";
const SIGNED_OUT = /Please sign in\b/iu;

export async function readAntigravityAuthStatus(
  installation: AvailableInstallation,
  options: AuthStatusOptions & { readonly signal?: AbortSignal; readonly includeAccount?: boolean } = {},
): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const env = sessionEnvironment(options.env);
  if (!antigravityUsesDefaultState(env)) { return { kind: "unknown", detail: ANTIGRAVITY_STATE_QUERY_UNAVAILABLE }; }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const version = await antigravityVersionPreflight(installation, env, { timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (version.kind === "unsupported") {
    const { kind: _kind, reason, ...versions } = version;
    return { kind: "unknown", ...versions, detail: reason };
  }
  const result = await runExecutable(installation.command, ["models"], {
    env, timeoutMs: version.timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.ok) {
    const account = options.includeAccount === true
      ? await readAntigravityAccount(installation.command, env, { timeoutMs: Math.max(deadline - Date.now(), 0), ...(options.signal === undefined ? {} : { signal: options.signal }) })
      : undefined;
    return { kind: "logged_in", ...(account === undefined ? {} : { account }), source: SOURCE };
  }
  // Its refusal names the missing login; any other failure (network, a crash) says nothing about it.
  if (result.exitCode === 1 && SIGNED_OUT.test(`${result.stdout}\n${result.stderr}`)) {
    const lastAccount = options.includeAccount === true ? await rememberedAntigravityAccount(env) : undefined;
    return { kind: "logged_out", source: SOURCE, ...(lastAccount === undefined ? {} : { lastAccount }) };
  }
  return { kind: "unknown", source: SOURCE, detail: "agy models ended without saying whether it is signed in" };
}

/** Whether Antigravity is signed in, by its own model listing (a remote call: not localOnly). */
export async function antigravityAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  try {
    const status = await withQueryDeadline<AuthStatus>("Antigravity auth status", options.timeoutMs ?? 30_000, async (signal) => {
      const read = await readAntigravityAuthStatus(installation, { ...options, includeAccount: true, signal });
      return read;
    }, { kind: "unknown", source: SOURCE, detail: "Antigravity auth status timed out" });
    return status;
  } catch {
    return { kind: "unknown", detail: "Antigravity authentication status could not be read" };
  }
}
