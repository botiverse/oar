import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/** Official script/npm layouts that can be invisible to GUI-process PATH. */
export function grokInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "grok.exe" : "grok";
  return [
    ...(env.GROK_BIN_DIR === undefined || env.GROK_BIN_DIR === ""
      ? []
      : [paths.join(env.GROK_BIN_DIR, executable)]),
    ...(env.GROK_HOME === undefined || env.GROK_HOME === ""
      ? []
      : [paths.join(env.GROK_HOME, "bin", executable)]),
    paths.join(home, ".grok", "bin", executable),
  ];
}

export const grokInstallation = executableInstallation(
  "OAR_GROK_BIN",
  "grok",
  grokInstalledExecutableCandidates,
  ["agent", "stdio", "--help"],
);
