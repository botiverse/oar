import path from "node:path";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";
import { ANTIGRAVITY_MINIMUM_VERSION, antigravityVersionRefusal, readAntigravityVersion } from "./version.js";

export { readAntigravityVersion } from "./version.js";

/** Official installer locations, including GUI hosts whose PATH omits them. */
export function antigravityInstalledExecutableCandidates(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  if (platform === "win32") {
    const configured = environmentValue(env, "LOCALAPPDATA", platform);
    const local = configured === undefined || configured.length === 0 ? path.win32.join(home, "AppData", "Local") : configured;
    return [path.win32.join(local, "agy", "bin", "agy.exe")];
  }
  return [path.posix.join(home, ".local", "bin", "agy")];
}

/**
 * Older CLI releases accept unknown subcommands by printing help, so `--help`
 * verifies Antigravity CLI identity while the version policy enforces the 1.5.0
 * native ACP floor (and lets an official install win over an older PATH copy).
 */
export const antigravityInstallation = executableInstallation(
  "OAR_ANTIGRAVITY_BIN",
  "agy",
  (env) => antigravityInstalledExecutableCandidates(process.platform, environmentHome(env), env),
  ["--help"],
  {
    versionTimeoutMs: 30_000,
    readVersion: readAntigravityVersion,
    identity: {
      vendor: "Antigravity CLI (agy)",
      help: /\bUsage of\b[\s\S]*(?:--conversation|--print-timeout|--remote-agent|\bantigravity-cli\b|Start the Agent Client Protocol \(ACP\) stdio server)/u,
    },
    versionPolicy: {
      label: "Antigravity CLI",
      lines: [{ min: ANTIGRAVITY_MINIMUM_VERSION, stableOnly: true }],
      required: ANTIGRAVITY_MINIMUM_VERSION,
      formatReason: (command, _installed, raw) => {
        const base = antigravityVersionRefusal(raw)?.reason
          ?? `Antigravity requires a stable agy CLI ${ANTIGRAVITY_MINIMUM_VERSION} or newer with native ACP; this installation reports an unrecognized CLI version`;
        return `${base} (${command}). Update that CLI or point OAR_ANTIGRAVITY_BIN at a supported agy, not agy_acp_server`;
      },
    },
  },
);
