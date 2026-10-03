import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";

const SDK_PACKAGE = "@cursor/sdk";

/** The platforms `@cursor/sdk` 1.0.35 ships a native companion package for. */
const PLATFORMS: ReadonlySet<string> = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);

async function sdkLoads(): Promise<boolean> {
  try {
    // A string LITERAL, not SDK_PACKAGE: bundlers only compile in (and
    // resolve) literal specifiers, and this fallback exists for bundles.
    await import("@cursor/sdk");
    return true;
  } catch {
    return false;
  }
}

/**
 * Cursor ships inside this package as the `@cursor/sdk` dependency, the way
 * pi does: there is no executable to probe and no version to report (the
 * embedder pins the SDK). The SDK's agent needs its native companion package,
 * which exists only for the platforms in `PLATFORMS`.
 */
export function cursorInstallationFor(platform: string, arch: string, resolvable: () => Promise<boolean>): InstallationProbe {
  return async (): Promise<InstallationSnapshot> => {
    if (!PLATFORMS.has(`${platform}-${arch}`)) {
      return { kind: "unsupported", reason: `@cursor/sdk has no native package for ${platform}-${arch}` };
    }
    return await resolvable() ? { kind: "available", via: "bundled" } : { kind: "not_found" };
  };
}

export const cursorInstallation: InstallationProbe = cursorInstallationFor(process.platform, process.arch, async () => {
  try {
    import.meta.resolve(SDK_PACKAGE);
    return true;
  } catch {
    const loads = await sdkLoads();
    return loads;
  }
});
