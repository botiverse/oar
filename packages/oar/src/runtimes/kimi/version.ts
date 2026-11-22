import { extractSemver, parseSemver, semverAtLeast } from "../../shared/semver.js";

/** Whether `--version` names the patched `2.7.2-botiverse.1` (or later botiverse) KAP build. */
export function isKimiKapBotiverseVersion(version: string | undefined): boolean {
  const token = extractSemver(version);
  const parsed = token === undefined ? null : parseSemver(token);
  return parsed !== null && parsed.prerelease[0] === "botiverse" && semverAtLeast(token, "2.7.2-botiverse.1");
}

/** Whether an executable version should probe KAP `/meta` before falling back to ACP. */
export function isKimiKapCandidate(version: string | undefined): boolean {
  return isKimiKapBotiverseVersion(version) || semverAtLeast(version, "2.7.3");
}
