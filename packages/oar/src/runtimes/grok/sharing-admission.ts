import type { AvailableInstallation } from "../../contracts/installation.js";

/** Exact reviewed native version; initialize independently checks the running process. */
export function isGrokSharedVersion(version: unknown): boolean { return version === "1.0.70"; }

export function grokSharedRefusal(installation: AvailableInstallation, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const version = installation.via === "executable"
    ? /^grok (\d+\.\d+\.\d+) \([a-f\d]+\) \[stable\]$/u.exec(installation.version?.trim() ?? "")?.[1] : undefined;
  if (!isGrokSharedVersion(version)) { return "Grok shared placement is verified only for native 1.0.70 stable; the installed version is different or unknown"; }
  if (!((platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64"))) {
    return "Grok 1.0.70 shared placement is verified only on Linux x64, macOS arm64 and Windows x64";
  }
  return null;
}
