import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";

import type { PiProjectOptions } from "./options.js";

/** Use Pi's resolver, including version checks, without installing or executing extensions. */
export async function checkPiProjectPackages(cwd: string, agentDir: string, settings: SettingsManager, options: PiProjectOptions): Promise<void> {
  if (options.allowProjectPackageInstall === true || piOffline()) { return; }
  if ((settings.getProjectSettings().packages ?? []).length === 0 && (settings.getGlobalSettings().packages ?? []).length === 0) { return; }
  const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const missing = new Set<string>();
  // The public callback has no scope: conservatively include user packages
  // rather than reconstructing Pi's inheritance, deduplication or version rules.
  // oxlint-disable-next-line eslint/require-await, typescript/require-await -- Pi requires a Promise for this synchronous policy decision.
  await packages.resolve(async (source) => { missing.add(source); return "skip"; });
  if (missing.size > 0) {
    throw new RuntimeFailureError("invalid_request", `Pi configuration requires installing or replacing packages: ${[...missing].map((source) => JSON.stringify(source)).join(", ")}. OAR conservatively checks the complete native package list, including user packages, because Pi's missing-package callback does not report scope. Start the host with PI_OFFLINE=1, or explicitly use createPiRuntime({ allowProjectPackageInstall: true }). OAR has not loaded extensions, installed packages or changed persistent trust.`, { code: "project_packages_blocked" });
  }
}

/** Native lookup reports absent paths without substituting our own package resolver. */
export async function reportMissingPiPackages(cwd: string, agentDir: string, settings: SettingsManager): Promise<void> {
  if (!piOffline()) { return; }
  const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  for (const entry of settings.getProjectSettings().packages ?? []) {
    const source = typeof entry === "string" ? entry : entry.source;
    if (packages.getInstalledPath(source, "project") === undefined) {
      process.emitWarning(`Pi could not locate configured package ${JSON.stringify(source)} in its project store; PI_OFFLINE prevents installation. Check the project's package configuration before relying on its extensions.`, { code: "OAR_PI_PACKAGE_MISSING" });
    }
  }
}

/** Match native isOfflineModeEnabled exactly, including its whitespace handling. */
function piOffline(): boolean {
  const value = process.env.PI_OFFLINE?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
