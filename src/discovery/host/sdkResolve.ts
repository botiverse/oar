/**
 * Locate an installed SDK package from OAR's own module position.
 *
 * ⛔ Do NOT go back to `require.resolve("<pkg>/package.json")`.
 * Measured by Huaihuai against the Raft daemon's real dependencies, and
 * reproduced here as a tooth: modern SDKs ship an `exports` map that does not
 * expose `./package.json`, so that subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * while the package is perfectly installed and importable. Both the Kimi and Pi
 * probes used that subpath, so on a real daemon install they reported the SDK as
 * ABSENT. Under the identity split that is not a cosmetic version gap — canonical
 * `kimi` is defined as "SDK present", so a resolver false-negative silently
 * turns into "runtime not installed".
 *
 * The reliable route is the one the package itself publishes:
 *   1. resolve the package's MAIN ENTRY (honours `exports`);
 *   2. walk up from that entry to the nearest package.json whose `name` matches;
 *   3. read version/root from there.
 *
 * Entry resolution tries ESM `import.meta.resolve` first (it is the resolver the
 * `exports` map is written for) and falls back to CJS `require.resolve` for
 * packages that still ship a CJS main.
 *
 * ⚠️ Visibility is a packaging contract, not a code one: once OAR is published,
 * pnpm's strict node_modules means OAR can only see an SDK it declares. The
 * optional-peer metadata that makes this resolver able to see anything at all is
 * owned by the packaging seat (task #4). This file assumes nothing about cwd or
 * global prefixes — those fallbacks are not a contract.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedSdkPackage {
  /** The matched package name (which candidate spec won). */
  readonly name: string;
  readonly version: string;
  /** Directory containing the owning package.json. */
  readonly root: string;
  /** Absolute path to the resolved main entry — import THIS, do not guess dist/. */
  readonly entry: string;
}

/** Resolve a package's main entry to an absolute path, or null if not installed. */
export type EntryResolver = (spec: string) => string | null;

/** How far up we will look for the owning package.json before giving up. */
const MAX_WALK_UP = 20;

function defaultEntryResolver(spec: string): string | null {
  // ESM first: this is the resolver an `exports` map is authored against.
  try {
    const url = import.meta.resolve(spec);
    if (url.startsWith("file:")) return fileURLToPath(url);
  } catch {
    // fall through to CJS
  }
  try {
    return createRequire(import.meta.url).resolve(spec);
  } catch {
    return null;
  }
}

/**
 * Walk up from a resolved entry file to the package.json that declares `name`.
 *
 * Matching on name (rather than taking the first package.json found) is what
 * keeps a nested/bundled dependency from being mistaken for the package we
 * asked about — the entry may sit several directories below the package root.
 */
export function findOwningPackage(
  entryPath: string,
  expectedName: string,
): { version: string; root: string } | null {
  let dir = dirname(entryPath);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const parsed = JSON.parse(readFileSync(pj, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === expectedName) {
          const version = parsed.version;
          // A matching package.json with no usable version is a resolution
          // failure, not a reason to keep climbing into a parent package.
          return typeof version === "string" && version.length > 0
            ? { version, root: dir }
            : null;
        }
      } catch {
        // Unreadable/!JSON — keep climbing; a broken file higher up should not
        // mask a good one below the package root.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * First candidate spec that is genuinely installed and readable, else null.
 * Candidates are tried in order, so put the package Raft actually uses first.
 */
export function resolveSdkPackage(
  specs: readonly string[],
  resolveEntry: EntryResolver = defaultEntryResolver,
): ResolvedSdkPackage | null {
  for (const spec of specs) {
    const entry = resolveEntry(spec);
    if (entry === null) continue;
    const owner = findOwningPackage(entry, spec);
    if (owner === null) continue;
    return { name: spec, version: owner.version, root: owner.root, entry };
  }
  return null;
}
