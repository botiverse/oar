import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import { semverAtLeast } from "../../shared/semver.js";

/**
 * First verified Codex floor supporting `ephemeral: true` on both `thread/start`
 * and `thread/fork` with `thread.ephemeral` readback (present in the 0.169.0
 * schema and verified live on 0.172.0). Older releases ignore unknown JSON fields
 * and persist a rollout thread on disk before readback can reject it.
 */
export const CODEX_EPHEMERAL_SINCE = "0.169.0";

/** Version-gated refusal for `SessionOptions.ephemeral` below the verified floor or on an unknown version. */
export function codexEphemeralVersionRefusal(version?: string): RefusedSessionOptions {
  return semverAtLeast(version, CODEX_EPHEMERAL_SINCE)
    ? {}
    : { ephemeral: `Codex ephemeral sessions need a verified installation of ${CODEX_EPHEMERAL_SINCE} or later` };
}

/** Codex rejects `thread/name/set` (`-32600`, [env] 0.172.0) and `thread/goal/*` on ephemeral threads. */
export function checkCodexEphemeral(options: SessionOptions): void {
  if (options.ephemeral !== true) { return; }
  if (options.name !== undefined) {
    throw new UnsupportedOptionError("ephemeral", "codex ephemeral threads do not support name (thread/name/set rejects metadata updates on ephemeral threads)");
  }
  if (options.goals === true) {
    throw new UnsupportedOptionError("ephemeral", "codex ephemeral threads do not support goals (thread/goal/* rejects ephemeral threads)");
  }
}

/** Refusal when `ephemeral: true` was requested and codex did not confirm `thread.ephemeral === true`. */
export function codexEphemeralRefusal(method: string, options: SessionOptions, thread: JsonRecord | null): string | null {
  if (options.ephemeral !== true || thread?.ephemeral === true) { return null; }
  const said = thread !== null && "ephemeral" in thread ? `reported ephemeral=${JSON.stringify(thread.ephemeral)}` : "did not confirm ephemeral";
  return `codex ${method} ${said} although ephemeral was requested`;
}

export const codexRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  userConfiguration: "codex isolated homes can persist temporary history paths in the shared index, breaking resume after cleanup; user-configuration exclusion is not supported",
  nativeMemoryDefault: "Codex has no verified settings layer below user config.toml for features.memories (which defaults to false)",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
};

const CODEX_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const CODEX_SANDBOX_CONFIG_KEY = /^(?:sandbox_mode|default_permissions|["'](?:sandbox_mode|default_permissions)["'])\s*=|^(?:permissions|["']permissions["'])\s*[.=]/u;

/** Effective sandbox override for this Codex open (`"inherit"` leaves native configuration in charge). */
export function codexLaunchSandboxMode(options: SessionOptions, env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  // Default bypasses approvals and sandbox; nativePermissions: "inherit" wins per session over OAR_CODEX_SANDBOX.
  return options.nativePermissions === "inherit" ? "inherit" : env.OAR_CODEX_SANDBOX ?? "danger-full-access";
}

function inlineConfigOverride(arg: string): string | undefined {
  if (arg.startsWith("--config=")) { return arg.slice("--config=".length); }
  if (arg.startsWith("-c=")) { return arg.slice("-c=".length); }
  if (arg.startsWith("-c") && arg.length > 2) { return arg.slice(2); }
  return undefined;
}

function launchArgsOverrideSandbox(launchArgs: readonly string[] | undefined): boolean {
  if (launchArgs === undefined) { return false; }
  for (let index = 0; index < launchArgs.length; index += 1) {
    const arg = launchArgs[index] ?? "";
    if (arg === "--") { return false; }
    if ((arg.startsWith("-s") && !arg.startsWith("--")) || arg === "--sandbox" || arg.startsWith("--sandbox=") || arg === "--full-auto" || arg === "--dangerously-bypass-approvals-and-sandbox") {
      return true;
    }
    if (arg === "-c" || arg === "--config") {
      const value = launchArgs[index + 1];
      if (value !== undefined && CODEX_SANDBOX_CONFIG_KEY.test(value.trimStart())) { return true; }
      index += 1;
      continue;
    }
    const inline = inlineConfigOverride(arg);
    if (inline !== undefined && CODEX_SANDBOX_CONFIG_KEY.test(inline.trimStart())) { return true; }
  }
  return false;
}

/** Codex thread/resume and thread/fork restore persisted rollout permissions ahead of CLI `-c sandbox_mode=...` unless the RPC sets `sandbox`. */
export function codexResumeSandboxParams(options: SessionOptions, sandboxMode: string): JsonRecord {
  return options.nativePermissions !== "inherit"
    && CODEX_SANDBOX_MODES.has(sandboxMode)
    && !launchArgsOverrideSandbox(options.launchArgs)
    ? { sandbox: sandboxMode }
    : {};
}
