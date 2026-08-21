import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

// The SDK's exports map does not expose package.json, so walk up from the
// resolved entry module to the package manifest.
async function bundledSdkVersion(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(SDK_PACKAGE)));
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
  throw new Error(`Failed to locate the ${SDK_PACKAGE} package manifest`);
}

/** Pi ships inside this package as an SDK dependency; there is no executable to probe. */
export const piInstallation: InstallationProbe = async (): Promise<InstallationSnapshot> => ({
  kind: "available",
  via: "bundled",
  version: await bundledSdkVersion(),
});
