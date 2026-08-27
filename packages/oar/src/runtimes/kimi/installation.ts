import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/** Official native-installer layouts that can be invisible to GUI-process PATH. */
export function kimiInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "kimi.exe" : "kimi";
  return [
    ...(env.KIMI_INSTALL_DIR === undefined || env.KIMI_INSTALL_DIR === ""
      ? []
      : [paths.join(env.KIMI_INSTALL_DIR, "bin", executable)]),
    paths.join(home, ".kimi-code", "bin", executable),
    // Retain the previous command name only as the last compatibility fallback.
    "kimi-code",
  ];
}

export const kimiInstallation = executableInstallation(
  "OAR_KIMI_BIN",
  "kimi",
  kimiInstalledExecutableCandidates,
  ["acp", "--help"],
  { readinessTimeoutMs: 30_000, versionTimeoutMs: 30_000 },
);
