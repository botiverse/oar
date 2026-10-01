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

const SOURCE = "codex doctor --json";

/**
 * Codex's own check is the `updates.status` row of `codex doctor --json`
 * (codex 0.158.0): `latest version` and a `latest version status` verdict.
 * doctor exits 1 whenever any other row fails (no login, for one), so the
 * JSON decides, not the exit code. Its `update action` is `manual or unknown`
 * for a copy `codex update` cannot update (a copied binary, an app bundle).
 */
export function projectCodexUpdateStatus(installed: string, doctor: unknown): UpdateCheck {
  const checks = asRecord(asRecord(doctor)?.checks);
  const details = asRecord(asRecord(checks?.["updates.status"])?.details);
  const latest = details?.["latest version"];
  if (typeof latest !== "string") {
    return { kind: "unavailable", reason: "lookup_failed", detail: "codex doctor --json reports no latest version", source: SOURCE };
  }
  if (details?.["update action"] === "manual or unknown") {
    return { kind: "unavailable", reason: "unmanaged_installation", detail: "codex update cannot update this copy", source: SOURCE };
  }
  const check = comparedCheck(installed, latest, SOURCE);
  const status = details?.["latest version status"];
  if (check.kind !== "ok" || typeof status !== "string") {
    return check;
  }
  if (status.includes("newer version is available")) {
    return { ...check, updateAvailable: true };
  }
  return status.includes("not older") ? { ...check, updateAvailable: false } : check;
}

export async function codexCheckUpdate(installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> {
  const update = executableUpdate(installation);
  if (update.kind === "unavailable") {
    return update.check;
  }
  const { json } = await runCheckCommand(update.installation.command, ["doctor", "--json"], options.timeoutMs ?? CHECK_TIMEOUT_MS);
  if (json === undefined) {
    return { kind: "unavailable", reason: "lookup_failed", detail: "codex doctor --json printed no JSON", source: SOURCE };
  }
  return projectCodexUpdateStatus(update.installed, json);
}

/** `codex update` never checks and reports success even when its download failed, hence the version read-back. */
export async function codexUpgrade(installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> {
  const result = await upgradeExecutable(installation, { check: codexCheckUpdate, args: ["update"] }, options);
  return result;
}
