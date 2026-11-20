import type { VersionUnsupportedInstallation } from "../contracts/installation.js";
import { compareSemver, parseSemver } from "./semver.js";

/** One inclusive floor and optional upper bound for a product release line. */
export interface VersionLineConstraint {
  /** Major release line when bounded to one major (`1` implies `< 2.0.0`); omitted for an open-ended floor. */
  readonly major?: number;
  /** Minimum semver on this line (inclusive). */
  readonly min: string;
  /** Exclusive upper bound semver, when not implied by `major`. */
  readonly maxExclusive?: string;
  /** Reject prerelease builds (`1.5.0-beta.1`, `1.1.78-rc.1`); default false (semver prerelease ordering). */
  readonly stableOnly?: boolean;
}

/** Declarative version policy enforced by `executableInstallation`. */
export interface ExecutableVersionPolicy {
  /** Runtime label used in refusal messages. */
  readonly label: string;
  /** Accepted lines in order; a version is supported when it satisfies at least one line. */
  readonly lines: readonly VersionLineConstraint[];
  /** Human-readable requirement reported in `VersionUnsupportedInstallation.requiredVersion`. */
  readonly required: string;
  /** Extract a semver token from the reported version string; defaults to exact semver parsing. */
  readonly parseVersion?: (raw: string) => string | undefined;
  /** Custom refusal message when a runtime adds migration guidance. */
  readonly formatReason?: (command: string, installedVersion: string | undefined, rawVersion: string | undefined) => string;
}

function exactSemver(raw: string): string | undefined {
  const trimmed = raw.trim();
  return parseSemver(trimmed) === null ? undefined : trimmed;
}

/** Whether `version` satisfies one release-line constraint. */
export function satisfiesVersionLine(version: string, line: VersionLineConstraint): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) { return false; }
  if (line.stableOnly === true && parsed.prerelease.length > 0) { return false; }
  if (line.major !== undefined && parsed.release[0] !== line.major) { return false; }
  const lower = compareSemver(version, line.min);
  if (lower === null || lower < 0) { return false; }
  if (line.maxExclusive !== undefined) {
    const upper = compareSemver(version, line.maxExclusive);
    if (upper === null || upper >= 0) { return false; }
  }
  return true;
}

/** Return a typed `version_unsupported` refusal when `rawVersion` falls outside `policy`, or null when supported. */
export function evaluateVersionPolicy(
  command: string,
  rawVersion: string | undefined,
  policy: ExecutableVersionPolicy,
): VersionUnsupportedInstallation | null {
  const token = rawVersion === undefined ? undefined : (policy.parseVersion ?? exactSemver)(rawVersion);
  if (token !== undefined && policy.lines.some((line) => satisfiesVersionLine(token, line))) {
    return null;
  }
  const reported = token ?? (rawVersion === undefined || rawVersion.length === 0 ? "an unrecognized version" : JSON.stringify(rawVersion));
  const reason = policy.formatReason === undefined
    ? `${policy.label} requires ${policy.required}; this installation reports ${reported}`
    : policy.formatReason(command, token, rawVersion);
  return {
    kind: "unsupported",
    code: "version_unsupported",
    via: "executable",
    command,
    reason,
    ...(token === undefined ? {} : { installedVersion: token }),
    requiredVersion: policy.required,
  };
}
