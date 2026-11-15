import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker } from "../../contracts/update.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { CHECK_TIMEOUT_MS, comparedCheck, executableUpdate, readReleaseSource, versionAtLeast } from "../../shared/update.js";

const RELEASE_SOURCES: Readonly<Record<string, string>> = {
  "curl-bash": "https://static.devin.ai/cli/current/manifest.json",
  "irm-iex": "https://static.devin.ai/cli/current/manifest.json",
  "curl-bash-enterprise": "https://static.devinenterprise.com/cli/current/manifest-enterprise.json",
  "irm-iex-enterprise": "https://static.devinenterprise.com/cli/current/manifest-enterprise.json",
  "curl-bash-windsurfcom": "https://static.devin.ai/cli/current/manifest-windsurfcom.json",
  "irm-iex-windsurfcom": "https://static.devin.ai/cli/current/manifest-windsurfcom.json",
};

/** Release manifest URL for a standalone Devin CLI `distribution` marker. */
export function devinReleaseSource(distribution: string | undefined): string | undefined {
  if (distribution === undefined) {
    return undefined;
  }
  return Object.hasOwn(RELEASE_SOURCES, distribution) ? RELEASE_SOURCES[distribution] : undefined;
}

/** Read the standalone installer's `distribution` marker next to the resolved binary's parent directory. */
export function readDevinDistribution(command: string): string | undefined {
  try {
    const real = realpathSync(command);
    const trimmed = readFileSync(path.resolve(path.dirname(real), "..", "distribution"), "utf8").trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Check for Devin CLI updates using the standalone installer's release manifest. */
export function devinUpdateCheck(
  options: { readonly manifestUrl?: string; readonly readDistribution?: (command: string) => string | undefined } = {},
): UpdateChecker {
  const readDistribution = options.readDistribution ?? readDevinDistribution;
  return async (installation: AvailableInstallation, checkOptions: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    const registry = options.manifestUrl ?? devinReleaseSource(readDistribution(update.installation.command));
    if (registry === undefined) {
      return {
        kind: "unavailable",
        reason: "unsupported_installation",
        detail: "Devin CLI update checks require a standalone installer marker (distribution); Homebrew, Desktop-bundled, and portal builds update through their host channel.",
      };
    }
    const read = await readReleaseSource(registry, checkOptions.timeoutMs ?? CHECK_TIMEOUT_MS);
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

export const devinCheckUpdate = devinUpdateCheck();
