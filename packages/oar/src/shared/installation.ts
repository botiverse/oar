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
  readonly vendor: string;
  readonly help?: RegExp;
  readonly version?: RegExp;
}

// An entry with a path separator is a pinned path: it must exist as given and
// never silently falls back to a different binary. A bare name resolves on PATH.
export interface ExecutableInstallationOptions {
  readonly readinessTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  readonly argsPrefix?: readonly string[];
  /** For executables whose `--version` does not lead with the version. */
  readonly readVersion?: VersionReader;
  readonly identity?: ExecutableIdentity;
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
    if (folders.has(folder)) {
      continue;
    }
    folders.add(folder);
    const file = realPath(match);
    if (files.has(file)) {
      continue;
    }
    if (files.size > 0) {
      shadowed.push(match);
    }
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
 * version policy and its version), kept while the file it resolves to is
 * unchanged. Hosts call `installation()` often (Raft before every usage read
 * and inventory), and a Node or Python CLI start costs seconds (codebuddy
 * ~3.6 s, kimi ~1.7 s on 2026-11-18). An upgrade by npm, uv, Homebrew, the
 * native installer or a staged self-update replaces the resolved file, which
 * changes its identity here, so the next probe runs again. Version-manager
 * shims are never cached (their file stays put across upgrades). OAR's own
 * install and upgrade clear the cache explicitly. Lookups follow the caller's
 * environment: the command is resolved first, the key covers the whole
 * environment (a readiness check can depend on HOME or a runtime's own home
 * variable), and a missing executable is never cached. A self-updater that
 * swaps a staged binary in at its next start (kimi) is seen once something
 * starts it again, such as a session or a usage read. Only successful verified
 * runs with a version are kept: a failure, unrecognized executable,
 * unsupported version or missing version is never cached.
 */
const runCache = new Map<string, { readonly identity: string; readonly version: string }>();

export function clearInstallationCache(): void {
  runCache.clear();
}

/**
 * Version-manager shims (Volta, asdf, mise, rtx, pyenv, rbenv, nodenv) keep
 * the same file at the command path while the tool behind it changes, so
 * their identity says nothing about the version: never cached.
 */
const SHIM_DIRECTORY = /[\\/](?:shims|\.?volta[\\/]bin)[\\/][^\\/]+$/iu;
const SHIM_BINARY = /^(?:volta-shim|mise|rtx|asdf)(?:\.exe)?$/iu;

function isVersionManagerShim(command: string, file: string): boolean {
  return SHIM_DIRECTORY.test(command) || SHIM_DIRECTORY.test(file) || SHIM_BINARY.test(path.basename(file));
}

function fileIdentity(command: string): string | null {
  try {
    const file = realpathSync.native(command);
    if (isVersionManagerShim(command, file)) {
      return null;
    }
    const stat = statSync(file, { bigint: true });
    return `${file}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

function runKey(command: string, readiness: readonly string[] | undefined, options: ExecutableInstallationOptions, env: Readonly<NodeJS.ProcessEnv>): string | null {
  // A custom version reader is a closure whose identity cannot be keyed safely.
  if (options.readVersion !== undefined) {
    return null;
  }
  // The whole environment: a readiness check can depend on HOME, a runtime's own home variable or NODE_OPTIONS, not only PATH.
  const environment = createHash("sha256").update(JSON.stringify(Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b, "en")))).digest("hex");
  const identityKey = options.identity === undefined ? null : [options.identity.vendor, options.identity.help?.source ?? null, options.identity.help?.flags ?? null, options.identity.version?.source ?? null, options.identity.version?.flags ?? null];
  const policyKey = options.versionPolicy === undefined ? null : [options.versionPolicy.label, options.versionPolicy.required];
  return JSON.stringify([command, options.argsPrefix ?? null, readiness ?? null, identityKey, policyKey, environment]);
}

function cachedVersion(key: string | null, command: string): string | undefined {
  if (key === null) {
    return undefined;
  }
  const hit = runCache.get(key);
  const identity = fileIdentity(command);
  return hit !== undefined && identity !== null && hit.identity === identity ? hit.version : undefined;
}

function remember(key: string | null, command: string, identity: string | null, version: string | undefined): void {
  if (key !== null && identity !== null && version !== undefined && fileIdentity(command) === identity) {
    runCache.set(key, { identity, version });
  }
}

function snapshotOf({ command, shadowed }: LocatedExecutable, version: string | undefined): InstallationSnapshot {
  const snapshot: ExecutableInstallation = {
    kind: "available",
    via: "executable",
    command,
    ...(version === undefined ? {} : { version }),
    ...(shadowed.length === 0 ? {} : { shadowed }),
  };
  return snapshot;
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
  const prefix = options.argsPrefix ?? [];

  if (readiness !== undefined) {
    const readyArgs = [...prefix, ...readiness];
    const result = await runExecutable(candidate.command, readyArgs, { env, ...(options.readinessTimeoutMs === undefined ? {} : { timeoutMs: options.readinessTimeoutMs }) });
    assertRan(result, `Failed to run ${candidate.command} ${readyArgs.join(" ")}`);
    if (!result.ok) { return { kind: "unsupported", code: "readiness_failed", via: "executable", command: candidate.command, reason: `${readiness.join(" ")} failed` }; }
    if (options.identity?.help !== undefined && !options.identity.help.test(`${result.stdout}\n${result.stderr}`)) {
      return { kind: "unsupported", code: "unrecognized_executable", via: "executable", command: candidate.command, reason: `${candidate.command} did not identify as ${options.identity.vendor}` };
    }
  }

  const versionArgs = [...prefix, "--version"];
  const versionResult = await runExecutable(candidate.command, versionArgs, { env, ...(options.versionTimeoutMs === undefined ? {} : { timeoutMs: options.versionTimeoutMs }) });
  assertRan(versionResult, `Failed to run ${candidate.command} ${versionArgs.join(" ")}`);
  if (!versionResult.ok && (options.identity?.version !== undefined || options.versionPolicy !== undefined)) {
    return { kind: "unsupported", code: "readiness_failed", via: "executable", command: candidate.command, reason: "--version failed" };
  }
  if (versionResult.ok && options.identity?.version !== undefined && !options.identity.version.test(versionResult.stdout.trim())) {
    return { kind: "unsupported", code: "unrecognized_executable", via: "executable", command: candidate.command, reason: `${candidate.command} did not identify as ${options.identity.vendor}` };
  }

  const raw = versionResult.ok ? (options.readVersion ?? firstLine)(versionResult.stdout)?.trim() : undefined;
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
 * policies are enforced in one place for every candidate. When no candidate is
 * usable, a `version_unsupported` refusal takes precedence so updaters can
 * still upgrade an older vendor installation behind an unrelated PATH copy.
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
    const pinned = envVar === "" ? undefined : environmentValue(env, envVar);
    const found: LocatedExecutable[] = [];
    if (pinned !== undefined && pinned !== "") {
      const located = locateExecutable(pinned, env);
      if (located !== null) {
        found.push({ command: located, shadowed: [] });
      }
    } else {
      for (const entry of [command, ...(typeof fallbacks === "function" ? fallbacks(env) : fallbacks)]) {
        const candidate = locateCandidate(entry, env);
        if (candidate !== null && !found.some((other) => other.command === candidate.command)) {
          found.push(candidate);
        }
      }
    }

    if (found.length === 0) {
      return { kind: "not_found" };
    }
    let firstRefusal: InstallationSnapshot | null = null;
    let versionRefusal: InstallationSnapshot | null = null;
    for (const candidate of found) {
      // oxlint-disable-next-line no-await-in-loop -- Candidates are probed in discovery order until one is usable.
      const snapshot = await probeCandidate(candidate, readiness, options, env);
      if (snapshot.kind === "available") {
        return snapshot;
      }
      firstRefusal ??= snapshot;
      if (snapshot.kind === "unsupported" && snapshot.code === "version_unsupported") {
        versionRefusal ??= snapshot;
      }
    }
    return versionRefusal ?? firstRefusal ?? { kind: "not_found" };
  };
}
