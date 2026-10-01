import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpgradeOptions, UpgradeResult } from "../../contracts/update.js";
import { asRecord } from "../../shared/json.js";
import {
  CHECK_TIMEOUT_MS,
  comparedCheck,
  executableUpdate,
  runCheckCommand,
  upgradeExecutable,
} from "../../shared/update.js";

const SOURCE = "grok update --check --json";

/**
 * grok 1.0.46 answers `update --check --json` with `currentVersion`,
 * `latestVersion`, `updateAvailable`, `installer`, `channel` and `error`,
 * and always exits 0: a failed lookup shows only in `error`. The check never
 * passes `--alpha`/`--stable`, which would persist a channel switch.
 */
export function projectGrokUpdateCheck(installed: string, report: unknown): UpdateCheck {
  const fields = asRecord(report);
  if (fields === null) {
    return { kind: "unavailable", reason: "lookup_failed", detail: "grok update --check --json printed no JSON", source: SOURCE };
  }
  const { error, latestVersion, updateAvailable, channel } = fields;
  if (typeof error === "string" && error !== "") {
    return { kind: "unavailable", reason: "lookup_failed", detail: error, source: SOURCE };
  }
  if (typeof latestVersion !== "string") {
    return { kind: "unavailable", reason: "lookup_failed", detail: "grok reported no latest version", source: SOURCE };
  }
  const check = comparedCheck(installed, latestVersion, SOURCE, typeof channel === "string" ? channel : undefined);
  return check.kind === "ok" && typeof updateAvailable === "boolean" ? { ...check, updateAvailable } : check;
}

export async function grokCheckUpdate(installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> {
  const update = executableUpdate(installation);
  if (update.kind === "unavailable") {
    return update.check;
  }
  const { json } = await runCheckCommand(update.installation.command, ["update", "--check", "--json"], options.timeoutMs ?? CHECK_TIMEOUT_MS);
  return projectGrokUpdateCheck(update.installed, json);
}

export async function grokUpgrade(installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> {
  const result = await upgradeExecutable(installation, { check: grokCheckUpdate, args: ["update"] }, options);
  return result;
}
