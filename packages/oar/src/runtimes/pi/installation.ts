import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

// The sdk's exports map does not expose package.json, so walk up from the
// resolved entry module to the manifest whose name matches. The name check
// matters: nested package.json files exist, and only the sdk's own manifest is
// version evidence.
async function manifestVersion(entry: string): Promise<string | null> {
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    const manifest: unknown = await readFile(manifestPath, "utf8").then(
      (content): unknown => JSON.parse(content),
      () => null,
    );
    if (
      typeof manifest === "object" && manifest !== null
      && "name" in manifest && manifest.name === SDK_PACKAGE
      && "version" in manifest && typeof manifest.version === "string"
    ) {
      return manifest.version;
    }
    directory = path.dirname(directory);
  }
  return null;
}

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
 * probe. Two evidence paths:
 *
 * 1. Normal installs: resolve the specifier and read the sdk's own manifest.
 * 2. Bundled/SEA deployments have no node_modules on disk, so resolution fails
 *    even though the code is compiled in — fall back to actually importing the
 *    sdk. That path reports no version: the sdk's `VERSION` export is not
 *    trustworthy evidence (it reads a `PI_PACKAGE_DIR`-overridable app
 *    directory and has been observed returning the embedding host's version).
 *
 * An install that omitted the optional dependency fails both paths and is an
 * honest not_found.
 */
export const piInstallation: InstallationProbe = async (): Promise<InstallationSnapshot> => {
  const entry = ((): string | null => {
    try {
      return fileURLToPath(import.meta.resolve(SDK_PACKAGE));
    } catch {
      return null;
    }
  })();

  if (entry !== null) {
    const version = await manifestVersion(entry);
    if (version !== null) {
      return { kind: "available", via: "bundled", version };
    }
  }
  if (await sdkLoads()) {
    return { kind: "available", via: "bundled" };
  }
  return { kind: "not_found" };
};
