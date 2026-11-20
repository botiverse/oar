import { homedir } from "node:os";
import path from "node:path";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";

/** Where Factory's own installer puts `droid` (`$HOME/.local/bin`), which a GUI process's PATH can miss. */
export function factoryInstalledExecutableCandidates(platform: NodeJS.Platform = process.platform, home: string = homedir()): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return [paths.join(home, ".local", "bin", platform === "win32" ? "droid.exe" : "droid")];
}

/** `droid exec --help` must run and identify Factory Droid (measured on droid 1.12.1). */
export const factoryInstallation = executableInstallation(
  "OAR_FACTORY_BIN",
  "droid",
  (env) => factoryInstalledExecutableCandidates(process.platform, environmentHome(env)),
  ["exec", "--help"],
  { identity: { vendor: "Factory Droid", help: /\bUsage:\s+droid(?:\.exe)?\s+exec\b/iu } },
);
