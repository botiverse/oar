import { compareSemver, parseSemver } from "../../shared/semver.js";
import type { VersionUnsupportedInstallation } from "../../contracts/installation.js";

export { compareSemver } from "../../shared/semver.js";

/** The oldest release the native vendor suite ran against. A release above it still passes through the method inventory. */
export const DSH_MINIMUM_VERSION = "0.2.1-rc.5";

/** Why this DSH cannot run, or null when it is at or above the floor. An unreadable version is never assumed to be supported. */
export function dshVersionRefusal(version: string | undefined): string | null {
  if (version === undefined || version.length === 0) { return `DSH did not report a version; OAR requires ${DSH_MINIMUM_VERSION} or later`; }
  const order = compareSemver(version, DSH_MINIMUM_VERSION);
  if (order === null) { return `DSH reported the unreadable version ${JSON.stringify(version)}; OAR requires ${DSH_MINIMUM_VERSION} or later`; }
  return order < 0 ? `DSH ${version} is below the supported floor; OAR requires ${DSH_MINIMUM_VERSION} or later` : null;
}

/** Structured reader refusal, using the same prerelease-aware floor as session open. */
export function dshVersionUnsupported(version: string | undefined): Omit<VersionUnsupportedInstallation, "via" | "command"> | null {
  const reason = dshVersionRefusal(version);
  return reason === null ? null : { kind: "unsupported" as const, code: "version_unsupported" as const, reason,
    ...(version === undefined || parseSemver(version) === null ? {} : { installedVersion: version }), requiredVersion: DSH_MINIMUM_VERSION };
}
