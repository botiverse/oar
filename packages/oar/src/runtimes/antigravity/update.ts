import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker } from "../../contracts/update.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { CHECK_TIMEOUT_MS, comparedCheck, executableUpdate, readReleaseSource, versionAtLeast } from "../../shared/update.js";

/**
 * agy_acp_server has no updater and Google publishes no latest pointer; the
 * ACP registry entry is the only release listing, and it trails Google's
 * own downloads (1.2.1 listed while 1.3.0 was downloadable on 2026-10-01).
 * So this check names the registry as its source, counts only a newer
 * registry version as an update, and there is no upgrade.
 */
export function antigravityUpdateCheck(
  registry = "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json",
): UpdateChecker {
  return async (installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
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
