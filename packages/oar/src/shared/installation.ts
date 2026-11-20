import { environmentValue, sessionEnvironment } from "./environment.js";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExecutableInstallation, InstallationProbe, InstallationSnapshot } from "../contracts/installation.js";
import { resolveExecutable, resolveExecutableAll, runExecutable, type VersionReader } from "./executable/index.js";
import { assertRan } from "./executable/diagnostics.js";
import { evaluateVersionPolicy, type ExecutableVersionPolicy } from "./version-range.js";

/** Vendor identity signature verified before accepting a located executable. */
export interface ExecutableIdentity {
  /** Human-readable vendor CLI name reported in refusal reasons. */
  readonly vendor: string;
  /** Pattern that readiness output (`stdout` + `stderr`) must match. */
  readonly help?: RegExp;
  /** Pattern that `--version` `stdout` must match. */
  readonly version?: RegExp;
}

// An entry with a path separator is a pinned path: it must exist as given and
// never silently falls back to a different binary. A bare name resolves on PATH.
export interface ExecutableInstallationOptions {
  readonly readinessTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  /** For executables whose `--version` does not lead with the version. */
  readonly readVersion?: VersionReader;
  /** Vendor identity signature; executables that fail it are refused as `unrecognized_executable`. */
  readonly identity?: ExecutableIdentity;
  /** Per-line version floor and upper-bound policy; versions outside it are refused as `version_unsupported`. */
  readonly versionPolicy?: ExecutableVersionPolicy;
}

export type ExecutableFallbacks = readonly string[] | ((env: Readonly<NodeJS.ProcessEnv>) => readonly string[]);

function isPinnedPath(entry: string): boolean {
  return entry.includes("/") || entry.includes("\\");
}

/**
 * Where an installation entry is, found without spawning anything: a pinned
 * path must exist as given, a bare name resolves on PATH (and PATHEXT on
 * Windows). Null when it is not there.
 */
export function locateExecutable(entry: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  if (isPinnedPath(entry)) {
    return existsSync(entry) ? entry : null;
  }
  return resolveExecutable(entry, env);
}

/** An executable found for an entry, and the copies on PATH it shadows (none for a pinned path). */
export interface LocatedExecutable {
  readonly command: string;
  readonly shadowed: readonly string[];
}

/** A bare command on PATH, like `which -a`: the copy that runs and the ones after it. Null when there is none. */
export function locateOnPath(name: string, env: Readonly<NodeJS.ProcessEnv> = process.env): LocatedExecutable | null {
  const matches = resolveExecutableAll(name, env);
  const [command] = matches;
  return command === undefined ? null : { command, shadowed: shadowedCopies(matches) };
}

function realPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * The copies PATH lists after the first of `matches` (which runs), in PATH
 * order, each once and as PATH spells it. Paths that resolve to one file are
 * one copy: a folder listed twice, `/bin` and `/usr/bin` on merged-usr Linux,
 * a symlink to the running copy. A folder holds one copy, the first match
 * there: Windows runs the first PATHEXT extension it finds, and the other
 * launchers beside it (npm writes `codex.cmd` and `codex.ps1` together) are
 * the same installation.
 */
export function shadowedCopies(matches: readonly string[]): readonly string[] {
  const folders = new Set<string>();
  const files = new Set<string>();
  const shadowed: string[] = [];
  for (const match of matches) {
    const folder = realPath(path.dirname(match));
    if (folders.has(folder)) { continue; }
    folders.add(folder);
    const file = realPath(match);
    if (files.has(file)) { continue; }
    if (files.size > 0) { shadowed.push(match); }
    files.add(file);
  }
  return shadowed;
}

function locateCandidate(entry: string, env: Readonly<NodeJS.ProcessEnv>): LocatedExecutable | null {
  if (isPinnedPath(entry)) {
    return existsSync(entry) ? { command: entry, shadowed: [] } : null;
  }
  return locateOnPath(entry, env);
}

/**
 * What a probe learned by running an executable (readiness, vendor identity,
 * version policy and version), kept while the resolved file is unchanged.
 * Version-manager shims, failures, unrecognized executables and unsupported
 * versions are never cached.
 */
const runCache = new Map<string, { readonly identity: string; readonly version: string }>();

export function clearInstallationCache(): void {
  runCache.clear();
}

const SHIM_DIRECTORY = /[\\/](?:shims|\.?volta[\\/]bin)[\\/][^\\/]+$/iu;
const SHIM_BINARY = /^(?:volta-shim|mise|rtx|asdf)(?:\.exe)?$/iu;

function isVersionManagerShim(command: string, file: string): boolean {
  return SHIM_DIRECTORY.test(command) || SHIM_DIRECTORY.test(file) || SHIM_BINARY.test(path.basename(file));
}

function fileIdentity(command: string): string | null {
  try {
    const file = realpathSync.native(command);
    if (isVersionManagerShim(command, file)) { return null; }
    const stat = statSync(file, { bigint: true });
    return `${file}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

function runKey(command: string, readiness: readonly string[] | undefined, options: ExecutableInstallationOptions, env: Readonly<NodeJS.ProcessEnv>): string | null {
  // Custom version readers are closures whose identity cannot be keyed safely.
  if (options.readVersion !== undefined) { return null; }
  const environment = createHash("sha256").update(JSON.stringify(Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b, "en")))).digest("hex");
  const identityKey = options.identity === undefined ? null : [
    options.identity.vendor,
    options.identity.help === undefined ? null : [options.identity.help.source, options.identity.help.flags],
    options.identity.version === undefined ? null : [options.identity.version.source, options.identity.version.flags],
  ];
  const policyKey = options.versionPolicy === undefined ? null : [options.versionPolicy.label, options.versionPolicy.required];
  return JSON.stringify([command, readiness ?? null, identityKey, policyKey, environment]);
}

function cachedVersion(key: string | null, command: string): string | undefined {
  if (key === null) { return undefined; }
  const hit = runCache.get(key);
  const identity = fileIdentity(command);
  return hit !== undefined && identity !== null && hit.identity === identity ? hit.version : undefined;
}

function remember(key: string | null, command: string, identity: string | null, version: string | undefined): void {
  if (key !== null && identity !== null && version !== undefined && fileIdentity(command) === identity) {
    runCache.set(key, { identity, version });
  }
}

function snapshotOf({ command, shadowed }: LocatedExecutable, version: string | undefined): ExecutableInstallation {
  return {
    kind: "available",
    via: "executable",
    command,
    ...(version === undefined ? {} : { version }),
    ...(shadowed.length === 0 ? {} : { shadowed }),
  };
}

function firstLine(stdout: string): string | undefined {
  return stdout.trim().split(/\r?\n/u)[0];
}

async function probeCandidate(
  candidate: LocatedExecutable,
  readiness: readonly string[] | undefined,
  options: ExecutableInstallationOptions,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<InstallationSnapshot> {
  const key = runKey(candidate.command, readiness, options, env);
  const cached = cachedVersion(key, candidate.command);
  if (cached !== undefined) { return snapshotOf(candidate, cached); }
  const identity = fileIdentity(candidate.command);

  if (readiness !== undefined) {
    const ready = await runExecutable(
      candidate.command,
      readiness,
      { env, ...(options.readinessTimeoutMs === undefined ? {} : { timeoutMs: options.readinessTimeoutMs }) },
    );
    assertRan(ready, `Failed to run ${candidate.command} ${readiness.join(" ")}`);
    if (!ready.ok) {
      return { kind: "unsupported", code: "readiness_failed", via: "executable", command: candidate.command, reason: `${readiness.join(" ")} failed` };
    }
    if (options.identity?.help !== undefined && !options.identity.help.test(`${ready.stdout}\n${ready.stderr}`)) {
      return { kind: "unsupported", code: "unrecognized_executable", via: "executable", command: candidate.command, reason: `${candidate.command} did not identify as ${options.identity.vendor}` };
    }
  }

  const versionResult = await runExecutable(
    candidate.command,
    ["--version"],
    { env, ...(options.versionTimeoutMs === undefined ? {} : { timeoutMs: options.versionTimeoutMs }) },
  );
  assertRan(versionResult, `Failed to run ${candidate.command} --version`);
  if (options.identity?.version !== undefined && (!versionResult.ok || !options.identity.version.test(versionResult.stdout.trim()))) {
    return { kind: "unsupported", code: "unrecognized_executable", via: "executable", command: candidate.command, reason: `${candidate.command} did not identify as ${options.identity.vendor}` };
  }

  const read = options.readVersion ?? firstLine;
  const raw = versionResult.ok ? read(versionResult.stdout)?.trim() : undefined;
  const version = raw === undefined || raw.length === 0 ? undefined : raw;
  if (options.versionPolicy !== undefined) {
    const refusal = evaluateVersionPolicy(candidate.command, version, options.versionPolicy);
    if (refusal !== null) { return refusal; }
  }

  remember(key, candidate.command, identity, version);
  return snapshotOf(candidate, version);
}

/**
 * An installation probed from an executable: the env var pins one candidate
 * exclusively; otherwise the command name and fallbacks are tried in order and
 * the first usable candidate wins. Readiness, vendor identity and version
 * policies are enforced in one place for every candidate. The copies a winner
 * found on PATH shadows are reported, never for a pinned env var.
 */
export function executableInstallation(
  envVar: string,
  command: string,
  fallbacks: ExecutableFallbacks = [],
  readiness?: readonly string[],
  options: ExecutableInstallationOptions = {},
): InstallationProbe {
  return async (probe = {}): Promise<InstallationSnapshot> => {
    const env = sessionEnvironment(probe.env);
    const pinned = environmentValue(env, envVar);
    const found: LocatedExecutable[] = [];
    if (pinned !== undefined && pinned !== "") {
      const located = locateExecutable(pinned, env);
      if (located !== null) { found.push({ command: located, shadowed: [] }); }
    } else {
      for (const entry of [command, ...(typeof fallbacks === "function" ? fallbacks(env) : fallbacks)]) {
        const candidate = locateCandidate(entry, env);
        if (candidate !== null && !found.some((other) => other.command === candidate.command)) { found.push(candidate); }
      }
    }

    if (found.length === 0) { return { kind: "not_found" }; }
    let firstRefusal: InstallationSnapshot | null = null;
    for (const candidate of found) {
      // oxlint-disable-next-line no-await-in-loop -- Candidates are probed in discovery order until one is usable.
      const snapshot = await probeCandidate(candidate, readiness, options, env);
      if (snapshot.kind === "available") { return snapshot; }
      firstRefusal ??= snapshot;
    }
    return firstRefusal ?? { kind: "not_found" };
  };
}
