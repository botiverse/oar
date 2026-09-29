import { executableInstallation } from "../../shared/installation.js";

/**
 * agy_acp_server 1.2.1 prints its build stamp for `--version`; the release
 * is the `Build label:` line. Its `--help` exits 1, so there is no cheap
 * readiness check beyond the version read.
 */
export function readAntigravityVersion(stdout: string): string | undefined {
  return /^Build label:\s*(\S+)/mu.exec(stdout)?.[1];
}

/**
 * The ACP registry ships the server as a zip that unpacks to
 * `agy_acp_server.par` (`agy_acp_server.exe` on Windows) with no installer,
 * so it is found on PATH or pinned with OAR_ANTIGRAVITY_BIN.
 */
export const antigravityInstallation = executableInstallation(
  "OAR_ANTIGRAVITY_BIN",
  process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
  [],
  undefined,
  { versionTimeoutMs: 30_000, readVersion: readAntigravityVersion },
);
