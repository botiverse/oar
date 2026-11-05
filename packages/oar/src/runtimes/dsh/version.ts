/** The oldest release the native vendor suite ran against. A release above it still passes through the method inventory. */
export const DSH_MINIMUM_VERSION = "0.2.1-rc.5";

type Identifier = number | string;
interface Parsed { readonly release: readonly [number, number, number]; readonly prerelease: readonly Identifier[] }

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u;

function parse(version: string): Parsed | null {
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
  const [a, b] = [parse(left), parse(right)];
  if (a === null || b === null) { return null; }
  for (const index of [0, 1, 2] as const) {
    const difference = a.release[index] - b.release[index];
    if (difference !== 0) { return difference; }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Why this DSH cannot run, or null when it is at or above the floor. An unreadable version is never assumed to be supported. */
export function dshVersionRefusal(version: string | undefined): string | null {
  if (version === undefined || version.length === 0) { return `DSH did not report a version; OAR requires ${DSH_MINIMUM_VERSION} or later`; }
  const order = compareSemver(version, DSH_MINIMUM_VERSION);
  if (order === null) { return `DSH reported the unreadable version ${JSON.stringify(version)}; OAR requires ${DSH_MINIMUM_VERSION} or later`; }
  return order < 0 ? `DSH ${version} is below the supported floor; OAR requires ${DSH_MINIMUM_VERSION} or later` : null;
}
