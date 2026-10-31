/* oxlint-disable import/max-dependencies -- Vendor sharing composes the existing ACP transport, profile and scoped admission policy. */
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions, StartSession } from "../../contracts/session.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { closeAcpSession } from "../../shared/acp/profile.js";
import type { AcpProcess } from "../../shared/acp/process.js";
import { sharedAcpSession } from "../../shared/acp/shared-session.js";
import type { AcpUnattributed } from "../../shared/acp/routing.js";
import { checkMcpServerNames } from "../../shared/mcp-servers.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { opencodeChildAttribution } from "./attribution.js";
import { opencodeSession, opencodeV2AcpProfile } from "./session.js";

/** Keep directory ownership after failed opens and disposal, until this native process is collected. */
export function openCodeDirectoryReservation(): (runtime: AcpProcess, options: SessionOptions) => Promise<string | null> {
  const used = new WeakMap<AcpProcess, Set<string>>();
  return async (runtime, options) => {
    const resolved = await realpath(options.cwd);
    const identity = await stat(resolved, { bigint: true });
    const directory = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    // File identity also catches case aliases on case-insensitive macOS volumes,
    // without conflating different directories on case-sensitive volumes.
    const keys = [`path:${directory}`, ...(identity.ino === 0n ? [] : [`file:${identity.dev}:${identity.ino}`])];
    const directories = used.get(runtime) ?? new Set<string>();
    if (keys.some(key => directories.has(key))) { return "OpenCode retains MCP configuration by directory until process exit; this canonical directory was already used on the shared process"; }
    // No await between check and reservation: concurrent aliases cannot both acquire the directory.
    for (const key of keys) { directories.add(key); }
    used.set(runtime, directories);
    return null;
  };
}

function processHome(options: SessionOptions): string {
  const env = sessionEnvironment(options.env);
  return environmentValue(env, process.platform === "win32" ? "USERPROFILE" : "HOME") ?? os.homedir();
}

/** Relative process inputs depend on the session cwd and lack the neutral-home launch evidence. */
function launchRefusal(command: string, options: SessionOptions): string | null {
  if ((options.launchArgs?.length ?? 0) > 0) { return "OpenCode shared placement has no startup-directory evidence for custom launchArgs"; }
  if (!path.isAbsolute(command) && /[/\\]/u.test(command)) { return "OpenCode shared placement requires an absolute executable path or a PATH command"; }
  const env = sessionEnvironment(options.env);
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"]) {
    const value = environmentValue(env, key);
    if (value !== undefined && value !== "" && !path.isAbsolute(value)) { return "OpenCode shared placement has no startup-directory evidence for relative home or configuration paths"; }
  }
  if (!path.isAbsolute(processHome(options))) { return "OpenCode shared placement requires an absolute process home"; }
  const search = environmentValue(env, "PATH");
  if (search !== undefined && search.split(path.delimiter).some(entry => !path.isAbsolute(entry))) {
    return "OpenCode shared placement has no startup-directory evidence for relative PATH entries";
  }
  return null;
}

export function createOpenCodeSharedSession(diagnostic: (entry: AcpUnattributed) => void = (entry) => {
  // Connection facts have no session owner. The shared router has already redacted every lease's credentials.
  console.error("[oar:opencode:shared]", JSON.stringify(entry));
}): StartSession {
  const open = sharedAcpSession(opencodeV2AcpProfile, {
    processCwd: processHome,
    reserveSession: openCodeDirectoryReservation(),
    associations: (method, params) => {
      const child = method === "session/update" ? opencodeChildAttribution(params) : null;
      return child === null ? [] : [{ parent: child.parent, child: child.sessionId }];
    },
    cleanup: closeAcpSession, diagnostic,
  });
  return withSessionCredentials(async (installation, options, _credentials, context) => {
    opencodeV2AcpProfile.validateOptions?.(options);
    checkMcpServerNames(options.mcpServers ?? []);
    if (installation.via !== "executable") { throw new Error("opencode requires an executable installation"); }
    const refusal = launchRefusal(installation.command, options);
    if (refusal !== null) {
      if (context.requested === "auto") { const session = await opencodeSession(installation, options, { requested: "auto", placement: "isolated" }); return session; }
      throw new UnsupportedOptionError("placement", refusal);
    }
    const cwd = await realpath(options.cwd);
    const session = await open(installation, { ...options, cwd }, context); return session;
  }, "shared");
}
