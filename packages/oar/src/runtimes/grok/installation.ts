import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
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
  const binDir = environmentValue(env, "GROK_BIN_DIR", platform);
  const grokHome = environmentValue(env, "GROK_HOME", platform);
  return [
    ...(binDir === undefined || binDir === ""
      ? []
      : [paths.join(binDir, executable)]),
    ...(grokHome === undefined || grokHome === ""
      ? []
      : [paths.join(grokHome, "bin", executable)]),
    paths.join(home, ".grok", "bin", executable),
  ];
}

export const grokInstallation = executableInstallation(
  "OAR_GROK_BIN",
  "grok",
  (env) => grokInstalledExecutableCandidates(process.platform, environmentHome(env), env),
  ["agent", "stdio", "--help"],
);
