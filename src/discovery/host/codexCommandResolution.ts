/**
 * Codex binary resolution — one source shared by detect / models (app-server) / usage.
 *
 * Ports raft daemon `resolveCompatibleCodexCandidate`
 * (repos/slock/packages/daemon/src/drivers/codex.ts) at oar's *discovery* scope:
 *   1. `CODEX_BIN` override — authoritative and **fail-closed**: when set it is
 *      used after an app-server probe or resolution fails; it never falls through
 *      to PATH/desktop and never competes in version arbitration.
 *   2. Automatic candidates: PATH → macOS `ChatGPT.app` desktop bundle →
 *      `~/.codex/plugins/.plugin-appserver/codex` → (win32) desktop `.exe`.
 *   3. An `app-server --help` probe **gates** every candidate — a `codex` too old
 *      to speak app-server (which `model/list` needs) is rejected, not selected.
 *   4. Version arbitration (`--version`) picks the newest app-server-capable
 *      candidate.
 *
 * Why oar needs this (previously PATH-only via `which("codex")`): a Codex user
 * installed through ChatGPT.app, or a too-old `codex` on PATH, was invisible or
 * silently unusable for model/list. Arbitration reports/queries the codex that
 * would actually be used.
 *
 * ⛔ Deliberate non-ports (daemon-launch concerns, not discovery): Windows
 *    npm-global `codex.js` run via a node host, shell/sandbox-runner avoidance,
 *    and launch env injection. oar spawns the resolved binary directly; a Windows
 *    npm `.js` entry that requires a separate `node` host is an explicit,
 *    documented gap rather than a silent one.
 */
import os from "node:os";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { runText, which, type CommandRunner } from "../cli.js";

export type CodexBinSource = "explicit_bin" | "path" | "desktop_bundle";

export type CodexResolution =
  | { ok: true; command: string; version: string | null; source: CodexBinSource; notes: string[] }
  | { ok: false; reason: "override_failed" | "none"; rejected: string[] };

/** Parsed Codex version: core triple + optional numeric prerelease trail. */
export type ParsedCodexVersion = {
  core: [number, number, number];
  /** null = release build (ranks above any prerelease with the same core). */
  pre: number[] | null;
};

/**
 * Parse real Codex version strings (`codex-cli 0.144.6`, `0.147.0-alpha.6.5`).
 * Pure — unit-tested without a filesystem or subprocess.
 */
export function parseCodexVersion(raw: string | null | undefined): ParsedCodexVersion | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  const core: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4]) return { core, pre: null };
  const pre = m[4]
    .split(/[.-]/)
    .map((part) => {
      const n = Number(part);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n): n is number => n !== null);
  return { core, pre };
}

/** Compare Codex versions; >0 if a newer than b. Unparseable → null. Pure. */
export function compareCodexVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const pa = parseCodexVersion(a);
  const pb = parseCodexVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i]! > pb.core[i]!) return 1;
    if (pa.core[i]! < pb.core[i]!) return -1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa.pre[i] ?? 0;
    const bv = pb.pre[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/**
 * macOS desktop-bundled Codex CLI locations that are real install surfaces.
 * `Codex.app` is intentionally NOT listed: shipping installs put the CLI under
 * ChatGPT.app; a dead Codex.app path would re-select a missing fallback and mask
 * PATH/override failures (raft codex.ts rationale). Use CODEX_BIN for one-offs.
 */
function darwinDesktopCodexPaths(homeDir: string): string[] {
  return [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(homeDir, ".codex", "plugins", ".plugin-appserver", "codex"),
  ];
}

type CandidateProbe = { appServerOk: boolean; version: string | null };

export type CodexResolveDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  which?: (cmd: string, env?: NodeJS.ProcessEnv) => string | null;
  exists?: (p: string) => boolean;
  /** app-server `--help` gate + `--version` read for one command path. */
  probe?: (command: string) => CandidateProbe;
  /**
   * Raw command runner used by the real probe. Injecting this supplies command RESULTS;
   * `appServerOk`/`version` are still derived here, never injected pre-computed.
   */
  runCommand?: CommandRunner;
};

type Candidate = { source: CodexBinSource; command: string };

/**
 * Automatic discovery candidates only. `CODEX_BIN` is never mixed in here — it is
 * a separate authoritative decision before arbitration.
 */
function codexSpawnCandidates(deps: Required<Pick<CodexResolveDeps, "platform" | "homeDir" | "env">> & {
  which: (cmd: string, env?: NodeJS.ProcessEnv) => string | null;
  exists: (p: string) => boolean;
}): Candidate[] {
  const candidates: Candidate[] = [];
  const pathCommand = deps.which("codex", deps.env);
  if (pathCommand) candidates.push({ source: "path", command: pathCommand });

  if (deps.platform === "darwin") {
    for (const bundle of darwinDesktopCodexPaths(deps.homeDir)) {
      if (!deps.exists(bundle)) continue;
      if (candidates.some((c) => c.command === bundle)) continue;
      candidates.push({ source: "desktop_bundle", command: bundle });
    }
  }
  return candidates;
}

/** Real probe: app-server `--help` must succeed (gate); then read `--version`. */
function probeCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  run: CommandRunner = runText,
): CandidateProbe {
  const help = run(command, ["app-server", "--help"], { timeoutMs: 5_000, env });
  if (!help.ok) return { appServerOk: false, version: null };
  const ver = run(command, ["--version"], { timeoutMs: 5_000, env });
  const version = ver.ok ? (ver.stdout.trim().split(/\r?\n/)[0] || null) : null;
  return { appServerOk: true, version };
}

type ProbeCacheEntry = { mtimeMs: number; size: number } & CandidateProbe;
const probeCache = new Map<string, ProbeCacheEntry>();

/** Test hook: empty the process-local app-server/version probe cache. */
export function clearCodexProbeCacheForTests(): void {
  probeCache.clear();
}

function cachedProbe(
  command: string,
  probe: (command: string) => CandidateProbe,
  exists: (p: string) => boolean,
): CandidateProbe {
  let stat: { mtimeMs: number; size: number } | null = null;
  if (exists(command)) {
    try {
      const st = statSync(command);
      stat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      stat = null;
    }
  }
  if (stat) {
    const cached = probeCache.get(command);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { appServerOk: cached.appServerOk, version: cached.version };
    }
  }
  const result = probe(command);
  if (stat) probeCache.set(command, { ...stat, ...result });
  return result;
}

function explicitOverride(env: NodeJS.ProcessEnv, exists: (p: string) => boolean, whichFn: (cmd: string, env?: NodeJS.ProcessEnv) => string | null):
  | { status: "unset" }
  | { status: "resolved"; command: string }
  | { status: "invalid"; raw: string; reason: string } {
  const raw = env.CODEX_BIN?.trim();
  if (!raw) return { status: "unset" };
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return exists(raw)
      ? { status: "resolved", command: raw }
      : { status: "invalid", raw, reason: "path does not exist" };
  }
  const onPath = whichFn(raw, env);
  return onPath
    ? { status: "resolved", command: onPath }
    : { status: "invalid", raw, reason: "not found on PATH" };
}

/**
 * Resolve the Codex CLI binary oar should detect / drive app-server / read usage
 * against. Fail-closed on a set-but-unusable `CODEX_BIN`.
 */
export function resolveCodexBin(deps: CodexResolveDeps = {}): CodexResolution {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const whichFn = deps.which ?? which;
  const exists = deps.exists ?? existsSync;
  const runCommand = deps.runCommand ?? runText;
  const rawProbe = deps.probe ?? ((command: string) => probeCommand(command, env, runCommand));
  const probe = (command: string): CandidateProbe => cachedProbe(command, rawProbe, exists);

  // 1) Explicit override — authoritative, fail-closed.
  const override = explicitOverride(env, exists, whichFn);
  if (override.status === "invalid") {
    return { ok: false, reason: "override_failed", rejected: [`CODEX_BIN=${override.raw} rejected: ${override.reason}`] };
  }
  if (override.status === "resolved") {
    const { appServerOk, version } = probe(override.command);
    if (!appServerOk) {
      return {
        ok: false,
        reason: "override_failed",
        rejected: [`CODEX_BIN=${override.command} rejected: app-server probe failed`],
      };
    }
    return {
      ok: true,
      command: override.command,
      version,
      source: "explicit_bin",
      notes: [`using CODEX_BIN override ${override.command}; automatic PATH/desktop discovery skipped`],
    };
  }

  // 2) Automatic discovery — version-arbitrate among app-server-capable candidates.
  const rejected: string[] = [];
  const notes: string[] = [];
  let best: { candidate: Candidate; version: string | null } | null = null;

  for (const candidate of codexSpawnCandidates({ platform, homeDir, env, which: whichFn, exists })) {
    const { appServerOk, version } = probe(candidate.command);
    if (!appServerOk) {
      rejected.push(`${candidate.source} ${candidate.command} rejected: app-server probe failed`);
      continue;
    }
    if (!best) {
      best = { candidate, version };
      continue;
    }
    const cmp = compareCodexVersions(version, best.version);
    if (cmp !== null && cmp > 0) {
      notes.push(
        `selected ${candidate.command} (${version ?? "unknown"}) over ${best.candidate.command} (${best.version ?? "unknown"}) by version`,
      );
      best = { candidate, version };
    }
  }

  if (!best) return { ok: false, reason: "none", rejected };
  return { ok: true, command: best.candidate.command, version: best.version, source: best.candidate.source, notes };
}
