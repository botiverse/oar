import { existsSync } from "node:fs";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker } from "../../contracts/update.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { CHECK_TIMEOUT_MS, comparedCheck, executableUpdate, readReleaseSource, versionAtLeast } from "../../shared/update.js";

/** The same platform names and musl loader check used by the official installer. */
export function antigravityReleaseSource(platform: NodeJS.Platform, arch: string, musl = false): string | undefined {
  const systems: Readonly<Partial<Record<NodeJS.Platform, string>>> = { linux: "linux", darwin: "darwin", win32: "windows", android: "android" };
  const system = systems[platform];
  if (system === undefined || (arch !== "x64" && arch !== "arm64")) { return undefined; }
  const architecture = arch === "x64" ? "amd64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  return `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${system}_${architecture}${suffix}.json`;
}

/** The CLI installer and updater use Google's platform release manifest. */
export function antigravityUpdateCheck(
  registry = antigravityReleaseSource(process.platform, process.arch, existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1")),
): UpdateChecker {
  return async (installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    if (registry === undefined) {
      return { kind: "unavailable", reason: "unsupported_installation", detail: "No official agy release manifest for this platform and architecture" };
    }
    const read = await readReleaseSource(registry, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    if (!read.ok) {
      return read.check;
    }
    const version = asRecord(parseJson(read.text))?.version;
    const check = comparedCheck(update.installed, typeof version === "string" ? version : "", registry);
    return check.kind === "ok" && check.updateAvailable
      ? { ...check, updateAvailable: !versionAtLeast(check.installed, check.latest) }
      : check;
  };
}

export const antigravityCheckUpdate = antigravityUpdateCheck();
