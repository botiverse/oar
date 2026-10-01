import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker, Upgrader, UpgradeOptions, UpgradeResult } from "../../contracts/update.js";
import {
  CHECK_TIMEOUT_MS,
  comparedCheck,
  executableUpdate,
  installedPath,
  readReleaseSource,
  upgradeExecutable,
  versionAtLeast,
} from "../../shared/update.js";

/**
 * Kimi has no check-only command; `kimi upgrade` (2.1.1) reads
 * `code.kimi.com/kimi-code/latest`, or `code.kimi.ai` when the recorded
 * region is `global`, and ignores the staged rollout, so that pointer is the
 * version it installs, and only when it is newer. A Homebrew copy only prints
 * `brew upgrade kimi-code`.
 */
export interface KimiUpdateSources {
  readonly mainland: string;
  readonly global: string;
  readonly home: () => string;
}

const sources: KimiUpdateSources = {
  mainland: "https://code.kimi.com/kimi-code/latest",
  global: "https://code.kimi.ai/kimi-code/latest",
  home: () => process.env.KIMI_CODE_HOME ?? path.join(homedir(), ".kimi-code"),
};

/** `upgrade -y` arrived in kimi 0.43.0; before it the upgrade only runs from a terminal prompt. */
const NON_INTERACTIVE_UPGRADE = "0.43.0";

function region(home: string): string {
  try {
    return readFileSync(path.join(home, "region"), "utf8").trim();
  } catch {
    return "";
  }
}

export function kimiUpdateCheck(from: KimiUpdateSources = sources): UpdateChecker {
  return async (installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    if (installedPath(update.installation.command).includes("/Cellar/")) {
      return { kind: "unavailable", reason: "package_manager", detail: "this copy updates through Homebrew" };
    }
    const url = region(from.home()) === "global" ? from.global : from.mainland;
    const read = await readReleaseSource(url, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    if (!read.ok) {
      return read.check;
    }
    // kimi upgrade acts only on a newer release.
    const check = comparedCheck(update.installed, read.text.trim(), url);
    return check.kind === "ok" ? { ...check, updateAvailable: !versionAtLeast(check.installed, check.latest) } : check;
  };
}

export const kimiCheckUpdate = kimiUpdateCheck();

export function kimiUpgrader(check: UpdateChecker = kimiCheckUpdate): Upgrader {
  return async (installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> => {
    const update = executableUpdate(installation);
    if (update.kind === "executable" && !versionAtLeast(update.installed, NON_INTERACTIVE_UPGRADE)) {
      return {
        kind: "unsupported",
        reason: "requires_terminal",
        detail: `kimi ${update.installed} has no non-interactive upgrade (added in ${NON_INTERACTIVE_UPGRADE}); run kimi upgrade in a terminal`,
      };
    }
    // A native install stages the new binary; the version read-back starts kimi, which swaps it in.
    const result = await upgradeExecutable(installation, { check, args: ["upgrade", "-y"] }, options);
    return result;
  };
}

export const kimiUpgrade = kimiUpgrader();
