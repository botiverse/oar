/* oxlint-disable import/max-dependencies -- Vendor sharing composes the existing ACP transport, profile and scoped admission policy. */
import os from "node:os";
import path from "node:path";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions, StartSession } from "../../contracts/session.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { asRecord } from "../../shared/json.js";
import { checkMcpServerNames } from "../../shared/mcp-servers.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { closeAcpSession } from "../../shared/acp/profile.js";
import { sharedAcpSession } from "../../shared/acp/shared-session.js";
import { acpDiagnosticSummary } from "../../shared/acp/diagnostic-summary.js";
import type { AcpUnattributed } from "../../shared/acp/routing.js";
import { grokAcpProfile, grokSession } from "./session.js";
import { isGrokSharedVersion } from "./sharing-admission.js";
import { grokSharedAssociations, grokSharedAssociationChecks } from "./sharing-attribution.js";

function processHome(options: SessionOptions, platform = process.platform): string {
  const env = sessionEnvironment(options.env, process.env, platform);
  return environmentValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform) ?? os.homedir();
}

/** Windows rooted or drive-relative paths depend on the neutral process's drive. */
function fullyQualified(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
    : path.posix.isAbsolute(value);
}

/** Relative startup inputs have no evidence for a process launched from neutral HOME. */
export function grokSharedLaunchRefusal(command: string, options: SessionOptions, platform = process.platform): string | null {
  if ((options.launchArgs?.length ?? 0) > 0) { return "Grok shared placement has no startup-directory evidence for custom launchArgs"; }
  if (!fullyQualified(command, platform) && (/[/\\]/u.test(command) || (platform === "win32" && /^[A-Za-z]:/u.test(command)))) { return "Grok shared placement requires an absolute executable path or a PATH command"; }
  if (!fullyQualified(options.cwd, platform)) { return "Grok shared placement requires an absolute session cwd"; }
  const env = sessionEnvironment(options.env, process.env, platform);
  for (const key of ["HOME", "USERPROFILE", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const value = environmentValue(env, key, platform);
    if (value !== undefined && value !== "" && !fullyQualified(value, platform)) { return "Grok shared placement has no startup-directory evidence for relative home or configuration paths"; }
  }
  if (!fullyQualified(processHome(options, platform), platform)) { return "Grok shared placement requires an absolute process home"; }
  const search = environmentValue(env, "PATH", platform);
  if (search !== undefined && search.split(platform === "win32" ? ";" : ":").some(entry => !fullyQualified(entry, platform))) {
    return "Grok shared placement has no startup-directory evidence for relative PATH entries";
  }
  if (options.mcpServers?.some(server => "command" in server) === true) {
    return "Grok shared placement cannot preserve stdio MCP working directories; use isolated placement or HTTP MCP";
  }
  return null;
}

export function createGrokSharedSession(diagnostic: (entry: AcpUnattributed) => void = acpDiagnosticSummary("grok")): StartSession {
  const open = sharedAcpSession(grokAcpProfile, {
    processCwd: processHome,
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Grok reports its version in the ACP extension envelope.
    initializationRefusal: response => isGrokSharedVersion(asRecord(response._meta)?.agentVersion) ? null
      : "Grok shared placement requires the running process to report _meta.agentVersion 1.0.70",
    associations: grokSharedAssociations, associationChecks: grokSharedAssociationChecks,
    // Linux timing: spawn led all 12 children by 68-83 ms, including 5 s child tasks.
    // This is a reordering allowance, never a wait for the completed tool result.
    pending: { waitMs: 1000, requestWaitMs: 1000, maxFrames: 256, maxBytes: 1024 * 1024 },
    cleanup: closeAcpSession, diagnostic,
  });
  return withSessionCredentials(async (installation, options, _credentials, context) => {
    grokAcpProfile.validateOptions?.(options);
    checkMcpServerNames(options.mcpServers ?? []);
    if (installation.via !== "executable") { throw new Error("grok requires an executable installation"); }
    const refusal = grokSharedLaunchRefusal(installation.command, options);
    if (refusal !== null) {
      if (context.requested === "auto") { const session = await grokSession(installation, options, { requested: "auto", placement: "isolated" }); return session; }
      throw new UnsupportedOptionError("placement", refusal);
    }
    const session = await open(installation, options, context); return session;
  }, "shared");
}
