import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExecutableInstallation, InstallationSnapshot } from "../contracts/installation.js";
import { runExecutable, type ExecutableResult, type VersionReader } from "./executable/index.js";
import { assertRan } from "./executable/diagnostics.js";
import { evaluateVersionPolicy, type ExecutableVersionPolicy } from "./version-range.js";

/** Vendor identity signature verified before accepting a located executable. */
export interface ExecutableIdentity {
  readonly vendor: string;
  readonly help?: RegExp;
  readonly version?: RegExp;
}

export interface ExecutableInstallationOptions {
  readonly readinessTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  readonly argsPrefix?: readonly string[];
  /** For executables whose `--version` does not lead with the version. */
  readonly readVersion?: VersionReader;
  readonly identity?: ExecutableIdentity;
  readonly versionPolicy?: ExecutableVersionPolicy;
}

/** An executable found for an entry, and the copies on PATH it shadows (none for a pinned path). */
export interface LocatedExecutable {
  readonly command: string;
  readonly shadowed: readonly string[];
}

/**
 * What a probe learned by running an executable (readiness, vendor identity,
 * version policy and its version), kept while the file it resolves to is
 * unchanged. Hosts call `installation()` often (Raft before every usage read
 * and inventory), and a Node or Python CLI start costs seconds (codebuddy
 * ~3.6 s, kimi ~1.7 s on 2026-11-18). An upgrade by npm, uv, Homebrew, the
 * native installer or a staged self-update normally changes the resolved
 * path or its stat identity (device, inode, size, mtime, ctime). A same-size
 * replacement that reuses the inode within one filesystem clock tick can
 * retain the entire identity and return the cached version. Version-manager
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

/**
 * Probes this process has started and not finished, by the same key the cache
 * uses. Two hosts that ask at once (a capability read beside an attach, a
 * model listing beside an open) wait on one native start instead of racing a
 * second one: the same executable, environment and arguments can only answer
 * the same thing. Nothing outlives the run — a settled key leaves before its
 * answer is returned — so a later caller is never served an old version by
 * this map; that is `runCache`'s job, and it re-checks the file identity.
 */
const inFlight = new Map<string, Promise<InstallationSnapshot>>();

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

/**
 * One candidate's native probe: from the cache when this process already
 * verified that file, joined to the single in-progress run when another caller
 * is already waiting on it, or started here.
 */
export async function probeCandidate(
  candidate: LocatedExecutable,
  readiness: readonly string[] | undefined,
  options: ExecutableInstallationOptions,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<InstallationSnapshot> {
  const key = runKey(candidate.command, readiness, options, env);
  const cached = cachedVersion(key, candidate.command);
  if (cached !== undefined) { return snapshotOf(candidate, cached); }
  if (key === null) { return probeExecutable(candidate, readiness, options, env, key); }
  const shared = inFlight.get(key);
  if (shared !== undefined) { return shared; }
  const running = trackProbe(key, probeExecutable(candidate, readiness, options, env, key));
  inFlight.set(key, running);
  const snapshot = await running;
  return snapshot;
}

/** Hold one in-progress probe under its key until it settles, whatever it settles with. */
async function trackProbe(key: string, probing: Promise<InstallationSnapshot>): Promise<InstallationSnapshot> {
  try {
    return await probing;
  } finally {
    inFlight.delete(key);
  }
}

/** Await a native start whose answer will go unread, because a refusal already decided the probe. */
async function unread(probe: Promise<unknown>): Promise<void> {
  try {
    await probe;
  } catch {
    // The refusal that beat this answer is the result; a late failure changes nothing.
  }
}

async function probeExecutable(
  candidate: LocatedExecutable,
  readiness: readonly string[] | undefined,
  options: ExecutableInstallationOptions,
  env: Readonly<NodeJS.ProcessEnv>,
  key: string | null,
): Promise<InstallationSnapshot> {
  const identity = fileIdentity(candidate.command);
  const prefix = options.argsPrefix ?? [];
  // Readiness and the version answer different questions about the same
  // executable, so the second native start belongs beside the first, not after
  // it: a runtime CLI boots its interpreter for seconds on every start
  // (codebuddy ~3.6 s and kimi ~1.7 s on 2026-11-18, hermes ~0.6 s here), and
  // a host waiting on an install would pay both. The verdicts are applied in
  // the original order below (readiness, then version), so a broken install
  // refuses exactly as before; the only extra work is one start a failed
  // readiness no longer needs.
  const versionArgs = [...prefix, "--version"];
  const readyArgs = readiness === undefined ? null : [...prefix, ...readiness];
  const versionRun = runExecutable(candidate.command, versionArgs, { env, ...(options.versionTimeoutMs === undefined ? {} : { timeoutMs: options.versionTimeoutMs }) });
  // Attach an async handler immediately so an early version rejection while readiness is still pending never surfaces as an unhandledRejection before await versionRun runs.
  void unread(versionRun);
  // A readiness check that is the version read itself is one command line: the
  // start that answers it answers both, and a second one would be the same
  // question asked twice.
  const readyRun = readyArgs === null || readyArgs.join("\u0000") === versionArgs.join("\u0000")
    ? versionRun
    : runExecutable(candidate.command, readyArgs, { env, ...(options.readinessTimeoutMs === undefined ? {} : { timeoutMs: options.readinessTimeoutMs }) });

  const refused = await readinessRefusal(candidate, readiness, readyRun, options, versionRun);
  if (refused !== null) { return refused; }

  const versionResult = await versionRun;
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
 * The refusal a readiness check decides, or null when the executable is ready:
 * a failed check, or output that does not carry the vendor's signature. The
 * version start runs beside it and is settled here before a refusal returns.
 */
async function readinessRefusal(
  candidate: LocatedExecutable,
  readiness: readonly string[] | undefined,
  readyRun: Promise<ExecutableResult>,
  options: ExecutableInstallationOptions,
  versionRun: Promise<unknown>,
): Promise<InstallationSnapshot | null> {
  if (readiness === undefined) { return null; }
  try {
    const result = await readyRun;
    assertRan(result, `Failed to run ${candidate.command} ${[...options.argsPrefix ?? [], ...readiness].join(" ")}`);
    if (!result.ok) {
      await unread(versionRun);
      return { kind: "unsupported", code: "readiness_failed", via: "executable", command: candidate.command, reason: `${readiness.join(" ")} failed` };
    }
    if (options.identity?.help !== undefined && !options.identity.help.test(`${result.stdout}\n${result.stderr}`)) {
      await unread(versionRun);
      return { kind: "unsupported", code: "unrecognized_executable", via: "executable", command: candidate.command, reason: `${candidate.command} did not identify as ${options.identity.vendor}` };
    }
    return null;
  } catch (error) {
    await unread(versionRun);
    throw error;
  }
}
