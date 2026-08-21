import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

async function sdkLoads(): Promise<boolean> {
  try {
    await import(SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pi ships inside this package as an sdk dependency; there is no executable to
 * probe and no version to report (the embedder pins the sdk version). Normal
 * installs resolve the specifier; bundled/SEA deployments have no node_modules
 * on disk, so fall back to actually importing the compiled-in sdk. An install
 * that omitted the optional dependency fails both and is an honest not_found.
 */
export const piInstallation: InstallationProbe = async (): Promise<InstallationSnapshot> => {
  const resolvable = ((): boolean => {
    try {
      import.meta.resolve(SDK_PACKAGE);
      return true;
    } catch {
      return false;
    }
  })();
  if (resolvable || await sdkLoads()) {
    return { kind: "available", via: "bundled" };
  }
  return { kind: "not_found" };
};
