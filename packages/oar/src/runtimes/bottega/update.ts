import type { AvailableInstallation, VersionUnsupportedInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker } from "../../contracts/update.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { CHECK_TIMEOUT_MS, comparedCheck, executableUpdate, readReleaseSource } from "../../shared/update.js";

/** npm's record of the latest published bottega. */
export const BOTTEGA_LATEST_URL = "https://registry.npmjs.org/@botiverse/bottega/latest";

/**
 * An executable bottega against npm's latest release. bottega has no
 * self-update command, so there is no `upgrade`: `install` reinstalls the
 * package, and a bundled bottega moves with the OAR that carries it.
 */
export function bottegaUpdateCheck(registry = BOTTEGA_LATEST_URL): UpdateChecker {
  return async (installation: AvailableInstallation | VersionUnsupportedInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") { return update.check; }
    const read = await readReleaseSource(registry, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    if (!read.ok) { return read.check; }
    const version = asRecord(parseJson(read.text))?.version;
    return comparedCheck(update.installed, typeof version === "string" ? version : "", registry);
  };
}

export const bottegaCheckUpdate = bottegaUpdateCheck();
