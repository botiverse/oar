import type { AvailableInstallation } from "../../contracts/installation.js";

/** Exact native versions with reviewed sharing evidence; no version ranges. */
export function isOpenCodeSharedVersion(version: unknown): boolean {
  return version === "2.2.3" || version === "2.2.5";
}

/** Exact cells in experiments/sharing/admission-2026-10-31.md; upgrades need new evidence. */
export function opencodeSharedRefusal(installation: AvailableInstallation, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const version = installation.via === "executable"
    ? /^(?:opencode\s+)?v?(\d+\.\d+\.\d+)$/u.exec(installation.version?.trim() ?? "")?.[1] : undefined;
  if (!isOpenCodeSharedVersion(version)) {
    return "OpenCode shared placement is verified only for native 2.2.3 or 2.2.5; the installed version is different or unknown";
  }
  if (!((platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64"))) {
    return "OpenCode 2.2.3 and 2.2.5 shared placement is verified only on Linux x64, macOS arm64 and Windows x64";
  }
  return null;
}
