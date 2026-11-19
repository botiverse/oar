type Identifier = number | string;
interface Parsed { readonly release: readonly [number, number, number]; readonly prerelease: readonly Identifier[] }

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseSemver(version: string): Parsed | null {
  const match = SEMVER.exec(version.trim());
  if (match === null) { return null; }
  const prerelease = match[4]?.split(".").map((part): Identifier => /^\d+$/u.test(part) ? Number(part) : part) ?? [];
  return { release: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}

/** Semver 2.0.0 section 11: numeric identifiers below alphanumeric ones, a prefix below a longer list, any prerelease below its release. */
function comparePrerelease(left: readonly Identifier[], right: readonly Identifier[]): number {
  if (left.length === 0 || right.length === 0) { return right.length - left.length; }
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const [a, b] = [left[index], right[index]];
    if (a !== b) {
      if (typeof a === "number" && typeof b === "number") { return a - b; }
      if (typeof a === "number") { return -1; }
      if (typeof b === "number") { return 1; }
      return String(a) < String(b) ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/** Negative, zero or positive by semver precedence; null when either side is not a version. */
export function compareSemver(left: string, right: string): number | null {
  const [a, b] = [parseSemver(left), parseSemver(right)];
  if (a === null || b === null) { return null; }
  for (const index of [0, 1, 2] as const) {
    const difference = a.release[index] - b.release[index];
    if (difference !== 0) { return difference; }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** First semver token inside a `--version` line, or undefined when none is present. */
export function extractSemver(versionText: string | undefined): string | undefined {
  return versionText === undefined ? undefined : /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\b/u.exec(versionText)?.[1];
}

/** Whether a `--version` line contains a semver at or above `floor` (prereleases sort below their release). */
export function semverAtLeast(versionText: string | undefined, floor: string): boolean {
  const token = extractSemver(versionText);
  const order = token === undefined ? null : compareSemver(token, floor);
  return order !== null && order >= 0;
}

/** Whether a `--version` line contains a readable semver strictly below `floor`. */
export function semverBelow(versionText: string | undefined, floor: string): boolean {
  const token = extractSemver(versionText);
  const order = token === undefined ? null : compareSemver(token, floor);
  return order !== null && order < 0;
}
