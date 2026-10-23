import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { UnsupportedOptionError } from "../../contracts/errors.js";

export interface PiProjectOptions {
  /** Trust this cwd for this open only. False disables native project configuration and extensions. */
  readonly projectTrusted?: boolean;
  /** Allow Pi to install packages named by project configuration. Defaults to false. */
  readonly allowProjectPackageInstall?: boolean;
}

/** Pi's SDK has only a process-wide offline switch; OAR never changes it. */
export function checkPiProjectPackages(settings: Pick<SettingsManager, "getProjectSettings">, options: PiProjectOptions): void {
  const packages = settings.getProjectSettings().packages ?? [];
  const offline = piOffline();
  if (packages.length > 0 && options.allowProjectPackageInstall !== true && !offline) {
    throw new UnsupportedOptionError("cwd", "Pi project configuration lists packages, but its in-process SDK cannot disable automatic installation per session. Start the host with PI_OFFLINE=1, or explicitly use createPiRuntime({ allowProjectPackageInstall: true }). OAR has not loaded project packages or changed persistent trust.");
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
