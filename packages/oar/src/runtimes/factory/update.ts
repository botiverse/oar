import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpgradeOptions, UpgradeResult } from "../../contracts/update.js";
import { CHECK_TIMEOUT_MS, comparedCheck, executableUpdate, updaterEnv, upgradeExecutable } from "../../shared/update.js";
import { runExecutable } from "../../shared/executable/index.js";

const SOURCE = "droid update --check";

/**
 * droid 1.12.1 prints "Current version: X", then "Update available: Y" or
 * "✓ Already up to date!" (its own i18n strings), and exits 0 either way.
 */
export function projectFactoryUpdateCheck(installed: string, output: string): UpdateCheck {
  const available = /^Update available: (\S+)$/mu.exec(output)?.[1];
  if (available !== undefined) { return comparedCheck(installed, available, SOURCE); }
  if (output.includes("Already up to date!")) { return comparedCheck(installed, installed, SOURCE); }
  const line = output.split("\n").map(text => text.trim()).find(text => text.length > 0 && !text.startsWith("Droid Update") && !text.startsWith("Current version"));
  return { kind: "unavailable", reason: "lookup_failed", detail: line ?? "droid update --check reported no version", source: SOURCE };
}

export async function factoryCheckUpdate(installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> {
  const update = executableUpdate(installation);
  if (update.kind === "unavailable") { return update.check; }
  const result = await runExecutable(update.installation.command, ["update", "--check"], { env: updaterEnv(), timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS });
  if (!result.ok) { return { kind: "unavailable", reason: "lookup_failed", detail: "droid update --check failed", source: SOURCE }; }
  return projectFactoryUpdateCheck(update.installed, `${result.stdout}\n${result.stderr}`);
}

export async function factoryUpgrade(installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> {
  const result = await upgradeExecutable(installation, { check: factoryCheckUpdate, args: ["update"] }, options);
  return result;
}
