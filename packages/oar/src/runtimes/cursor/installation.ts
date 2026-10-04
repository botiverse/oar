import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";

/** The platforms `@cursor/sdk` 1.0.35 ships a native companion package for. */
const PLATFORMS: ReadonlySet<string> = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);

/**
 * Cursor runs in process through `@cursor/sdk`, the way pi does, on the SDK
 * the host installs and hands over (`createCursorRuntime`): there is no
 * executable to probe and no version to report (the embedder pins the SDK),
 * and the host's own compile already found the package. The SDK's agent
 * needs its native companion package, which exists only for the platforms in
 * `PLATFORMS`.
 */
export function cursorInstallationFor(platform: string, arch: string): InstallationProbe {
  const snapshot: InstallationSnapshot = PLATFORMS.has(`${platform}-${arch}`)
    ? { kind: "available", via: "bundled" }
    : { kind: "unsupported", reason: `@cursor/sdk has no native package for ${platform}-${arch}` };
  return async () => {
    await Promise.resolve();
    return snapshot;
  };
}

export const cursorInstallation: InstallationProbe = cursorInstallationFor(process.platform, process.arch);
