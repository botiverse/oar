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

function processHome(options: SessionOptions): string {
  const env = sessionEnvironment(options.env);
  return environmentValue(env, process.platform === "win32" ? "USERPROFILE" : "HOME") ?? os.homedir();
}

/** Relative startup inputs have no evidence for a process launched from neutral HOME. */
export function grokSharedLaunchRefusal(command: string, options: SessionOptions): string | null {
  if ((options.launchArgs?.length ?? 0) > 0) { return "Grok shared placement has no startup-directory evidence for custom launchArgs"; }
  if (!path.isAbsolute(command) && /[/\\]/u.test(command)) { return "Grok shared placement requires an absolute executable path or a PATH command"; }
  if (!path.isAbsolute(options.cwd)) { return "Grok shared placement requires an absolute session cwd"; }
  const env = sessionEnvironment(options.env);
  for (const key of ["HOME", "USERPROFILE", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const value = environmentValue(env, key);
    if (value !== undefined && value !== "" && !path.isAbsolute(value)) { return "Grok shared placement has no startup-directory evidence for relative home or configuration paths"; }
  }
  if (!path.isAbsolute(processHome(options))) { return "Grok shared placement requires an absolute process home"; }
  const search = environmentValue(env, "PATH");
  if (search !== undefined && search.split(path.delimiter).some(entry => !path.isAbsolute(entry))) {
    return "Grok shared placement has no startup-directory evidence for relative PATH entries";
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
