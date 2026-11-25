import type { AvailableInstallation } from "../../contracts/installation.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { compareSemver } from "../../shared/semver.js";

/*
 * Session MCP credentials on Hermes are gated on the release OAR measured,
 * because the answer depends on the daemon rather than on the ACP wire: an
 * entry's `env`/`headers` reach the gateway owner, which keeps them in its own
 * process (`gateway/session_local_mcp.py`: `_local_editor_mcp`, "borrowed"
 * credentials) and persists only a fingerprint, the frozen schemas and the
 * derived server names. That is what makes the values ephemeral, and a later
 * owner that persisted them, or a stdio transport it spawned differently,
 * would not be visible from the ACP answer.
 *
 * Measured on `hermes 0.23.3+1139.g084538c` (2026-11-25, macOS arm64): the
 * gateway spawns the session's stdio server with the entry's `env`, the tool
 * process answers `tools/list` and `tools/call` under it, and a viewer that
 * resumes the session with the same list re-attaches the current generation's
 * values (the daemon restarts the server when the list's fingerprint changes).
 * Older, newer and unrecognized releases stay refused: `hermes --version`
 * prints the numeric release alone (`readHermesVersion`), and a build with
 * other metadata is the same release.
 */
export const HERMES_MCP_CREDENTIAL_RELEASE = "0.23.3";

/** Declared reason for a release whose session MCP credential handling OAR has not measured. */
export const HERMES_MCP_CREDENTIALS_UNVERIFIED =
  `OAR measured Hermes' session MCP env and header values (kept in the gateway owner's memory, not its persisted profile state) only on ${HERMES_MCP_CREDENTIAL_RELEASE}`;

/** Whether `installation` is the release whose credential handling OAR measured. A prerelease of it is not. */
export function hermesMeasuredMcpCredentials(installation: AvailableInstallation): boolean {
  if (installation.via !== "executable" || installation.version === undefined) { return false; }
  return compareSemver(installation.version, HERMES_MCP_CREDENTIAL_RELEASE) === 0;
}

/**
 * The refusals one installation adds to `hermesRefusedSessionOptions`, which
 * every release declares: `mcpServerCredentials` (an `mcpServers` entry with a
 * non-empty stdio `env` or http `headers`) on every release OAR has not
 * measured. `sessionCapabilities()` and the open read this one function, so a
 * host is never told an entry attaches and then refused, or the reverse.
 */
export function hermesInstallationRefusals(installation: AvailableInstallation): RefusedSessionOptions {
  return hermesMeasuredMcpCredentials(installation) ? {} : { mcpServerCredentials: HERMES_MCP_CREDENTIALS_UNVERIFIED };
}
