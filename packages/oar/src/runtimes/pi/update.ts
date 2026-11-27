import type { AvailableInstallation, VersionUnsupportedInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker, Upgrader } from "../../contracts/update.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { compareSemver } from "../../shared/semver.js";
import {
  CHECK_TIMEOUT_MS,
  comparedCheck,
  executableUpdate,
  readReleaseSource,
  upgradeExecutable,
  versionAtLeast,
} from "../../shared/update.js";

/** Official Pi CLI release version endpoint (`version-check.js`). */
export const PI_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";

/** Compare an explicit executable `pi` CLI against Pi's official latest-version endpoint. */
export function piUpdateCheck(registry = PI_LATEST_VERSION_URL): UpdateChecker {
  return async (installation: AvailableInstallation | VersionUnsupportedInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    const read = await readReleaseSource(registry, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    if (!read.ok) {
      return read.check;
    }
    const payload = asRecord(parseJson(read.text));
    if (payload?.ok === false) {
      return {
        kind: "unavailable",
        reason: "lookup_failed",
        detail: typeof payload.error === "string" && payload.error.length > 0 ? payload.error : "release endpoint returned ok: false",
        source: registry,
      };
    }
    const version = payload?.version;
    const check = comparedCheck(update.installed, typeof version === "string" ? version : "", registry);
    if (check.kind === "ok" && check.updateAvailable) {
      const order = compareSemver(check.installed, check.latest);
      return { ...check, updateAvailable: order !== null ? order < 0 : !versionAtLeast(check.installed, check.latest) };
    }
    return check;
  };
}

export const piCheckUpdate = piUpdateCheck();

/** Run native `pi update --self --no-approve` on the probed executable. */
export const piUpgrade: Upgrader = async (installation, options) => {
  const result = await upgradeExecutable(installation, { check: piCheckUpdate, args: ["update", "--self", "--no-approve"] }, options);
  return result;
};
