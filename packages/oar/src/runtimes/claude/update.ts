import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AvailableInstallation, VersionUnsupportedInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker, UpgradeOptions, Upgrader, UpgradeResult } from "../../contracts/update.js";
import { runIsolated } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";
import {
  CHECK_TIMEOUT_MS,
  comparedCheck,
  executableUpdate,
  installedPath,
  readReleaseSource,
  upgradeExecutable,
  versionAtLeast,
} from "../../shared/update.js";
import { claudeEnv } from "./environment.js";

/**
 * Claude has no check-only command, so the check reads what `claude update`
 * reads (claude 2.1.286): the native build follows
 * `downloads.claude.ai/claude-code-releases/<channel>`, an npm copy the npm
 * dist-tag of the same channel; the channel is settings `autoUpdatesChannel`
 * (`latest` unless `stable`), and a `minimumVersion` above that channel keeps
 * the installed version. Package-manager copies update through their package
 * manager, and `DISABLE_UPDATES` turns every update path off. Managed
 * (administrator) settings are not read.
 */
export interface ClaudeUpdateSources {
  readonly releases: string;
  readonly npm: string;
  readonly configDir: () => string;
  /** `.claude.json`, where claude records its `installMethod`. */
  readonly globalConfig: () => string;
  /** Read-only Linux system package owner check (`dpkg`/`rpm`/`apk`/`pacman`), bounded by `timeoutMs`. */
  readonly systemPackageManager?: (realPath: string, timeoutMs: number) => Promise<string | null>;
}

const DESKTOP_CACHE = /\/Library\/Application Support\/Claude\/claude-code\/[^/]+\/[^/]+\/claude\.app\/Contents\/MacOS\/claude$/u;
const DESKTOP_OWNER = "Claude Desktop installs, verifies and updates this copy";

// [sym] Claude 2.1.292: on Windows, the native installer copies the binary to
// `%USERPROFILE%\.local\bin\claude.exe` instead of symlinking into `/claude/versions/`,
// and its native-installation path predicate accepts `<home>/.local/bin/claude.exe`.
// On POSIX, `~/.local/bin/claude` must be a symlink into `/claude/versions/` (Claude's
// updater refuses to replace a non-symlink file there), so only the `.exe` launcher matches.
const WINDOWS_NATIVE_LAUNCHER = /\/\.local\/bin\/claude\.exe$/iu;

// [sym] Claude 2.1.292 path-based package-manager detectors (Homebrew, mise, asdf, WinGet).
const PACKAGE_MANAGED = ["/Caskroom/", "/Cellar/", "/mise/", "/asdf/", "/WinGet/", "/winget/"];

// [sym] Claude 2.1.292 Linux system-package ownership probes (apt/dnf/apk/pacman
// install to standard FHS paths like `/usr/bin/claude`, so path matching alone cannot identify them).
const LINUX_PACKAGE_MANAGERS = [
  { name: "pacman", distros: ["arch"], command: "pacman", args: ["-Qo"] },
  { name: "apk", distros: ["alpine"], command: "apk", args: ["info", "--who-owns"] },
  { name: "dpkg", distros: ["debian"], command: "dpkg", args: ["-S"] },
  { name: "rpm", distros: ["fedora", "rhel", "suse"], command: "rpm", args: ["-qf"] },
] as const;

const SYSTEM_PM_TIMEOUT_MS = 5000;

/** Minimal environment for read-only Linux package-ownership probes (no host credentials). */
export function packageProbeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = { LC_ALL: "C" };
  if (env.PATH !== undefined) { minimal.PATH = env.PATH; }
  if (env.LANG !== undefined) { minimal.LANG = env.LANG; }
  return minimal;
}

async function linuxOsIds(): Promise<readonly string[] | null> {
  try {
    const text = await readFile("/etc/os-release", "utf8");
    const id = /^ID=["']?(\S+?)["']?\s*$/mu.exec(text)?.[1];
    const like = /^ID_LIKE=["']?(.+?)["']?\s*$/mu.exec(text)?.[1]?.split(/\s+/u) ?? [];
    return [id, ...like].filter((value): value is string => value !== undefined && value.length > 0);
  } catch {
    return null;
  }
}

async function detectLinuxSystemPackageManager(realPath: string, timeoutMs: number): Promise<string | null> {
  if (process.platform !== "linux" || timeoutMs <= 0) { return null; }
  const deadline = Date.now() + timeoutMs;
  const osIds = await linuxOsIds();
  const env = packageProbeEnv();
  for (const pm of LINUX_PACKAGE_MANAGERS) {
    if (osIds !== null && !pm.distros.some((distro) => osIds.includes(distro))) { continue; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { return null; }
    const probeTimeout = Math.min(SYSTEM_PM_TIMEOUT_MS, remaining);
    // oxlint-disable-next-line no-await-in-loop -- ordered distro-filtered ownership lookup.
    const result = await runIsolated(pm.command, [...pm.args, realPath], { env, timeoutMs: probeTimeout }).catch((): null => null);
    if (result !== null && result.exitCode === 0 && result.stdout.trim().length > 0) {
      return pm.name;
    }
  }
  return null;
}

const sources: ClaudeUpdateSources = {
  releases: "https://downloads.claude.ai/claude-code-releases",
  npm: "https://registry.npmjs.org/@anthropic-ai/claude-code",
  configDir: () => process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
  globalConfig: () => path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"),
  systemPackageManager: detectLinuxSystemPackageManager,
};

export type ClaudeInstallMethod = "native" | "npm" | "package_manager" | "unknown";

/**
 * The layout decides where it is unambiguous:
 * - [env]/[sym] Claude 2.1.286/2.1.292: `/claude/versions/` is the native versions store.
 * - [sym] Claude 2.1.292: `/.local/bin/claude.exe` is the Windows native launcher (copied, not symlinked).
 * - [env]/[sym] Claude 2.1.286/2.1.292: `/node_modules/@anthropic-ai/claude-code/` is npm.
 * - [sym] Claude 2.1.292: `PACKAGE_MANAGED` segments are Homebrew, mise, asdf and WinGet.
 * - [env]/[sym] Claude 2.1.286/2.1.292: a shim whose path is ambiguous (pnpm bin, Windows `.cmd`)
 *   falls back to `recorded === "global"` for npm.
 * Any other layout (such as `/usr/bin/claude` or a manually copied binary) stays `"unknown"`
 * rather than guessing `"native"`.
 */
export function claudeInstallMethod(realPath: string, recorded?: unknown): ClaudeInstallMethod {
  const normalized = realPath.replaceAll("\\", "/");
  if (normalized.includes("/claude/versions/") || WINDOWS_NATIVE_LAUNCHER.test(normalized)) {
    return "native";
  }
  if (normalized.includes("/node_modules/@anthropic-ai/claude-code/")) {
    return "npm";
  }
  if (PACKAGE_MANAGED.some((segment) => normalized.includes(segment))) {
    return "package_manager";
  }
  return recorded === "global" ? "npm" : "unknown";
}

type ResolvedClaudeMethod =
  | { readonly method: "native" | "npm" | "unknown" }
  | { readonly method: "package_manager"; readonly manager?: string };

async function resolveClaudeInstallMethod(
  realPath: string,
  from: ClaudeUpdateSources,
  timeoutMs: number,
): Promise<ResolvedClaudeMethod> {
  const byPath = claudeInstallMethod(realPath);
  if (byPath !== "unknown") {
    return { method: byPath };
  }
  const manager = await (from.systemPackageManager ?? detectLinuxSystemPackageManager)(realPath, timeoutMs);
  if (manager !== null) {
    return { method: "package_manager", manager };
  }
  const recorded = readJsonRecord(from.globalConfig()).installMethod;
  return { method: claudeInstallMethod(realPath, recorded) };
}

function readJsonRecord(file: string): Record<string, unknown> {
  try {
    return asRecord(parseJson(readFileSync(file, "utf8"))) ?? {};
  } catch {
    return {};
  }
}

function updatesDisabled(settings: Record<string, unknown>): boolean {
  const fromEnv = process.env.DISABLE_UPDATES;
  const flag = fromEnv === undefined || fromEnv === "" ? asRecord(settings.env)?.DISABLE_UPDATES : fromEnv;
  return flag !== undefined && flag !== "" && flag !== "0" && flag !== false;
}

/** claude stays on its version when the channel is below settings `minimumVersion`. */
function withMinimum(check: UpdateCheck, minimum: unknown): UpdateCheck {
  return check.kind === "ok" && typeof minimum === "string" && !versionAtLeast(check.latest, minimum)
    ? { ...check, updateAvailable: false }
    : check;
}

async function npmCheck(
  installed: string,
  channel: string,
  source: { readonly url: string; readonly timeoutMs: number },
): Promise<UpdateCheck> {
  const read = await readReleaseSource(source.url, source.timeoutMs);
  if (!read.ok) {
    return read.check;
  }
  const version = asRecord(parseJson(read.text))?.version;
  return comparedCheck(installed, typeof version === "string" ? version : "", source.url, channel);
}

function unavailableForMethod(resolved: ResolvedClaudeMethod): UpdateCheck | null {
  if (resolved.method === "package_manager") {
    const owner = resolved.manager ?? "its package manager";
    return { kind: "unavailable", reason: "package_manager", detail: `this copy updates through ${owner}` };
  }
  if (resolved.method === "unknown") {
    return { kind: "unavailable", reason: "unmanaged_installation", detail: "Claude installation layout is not recognized" };
  }
  return null;
}

async function checkWithResolvedMethod(
  installed: string,
  resolved: ResolvedClaudeMethod,
  from: ClaudeUpdateSources,
  deadline: number,
): Promise<UpdateCheck> {
  const unavailable = unavailableForMethod(resolved);
  if (unavailable !== null) {
    return unavailable;
  }
  const settings = readJsonRecord(path.join(from.configDir(), "settings.json"));
  if (updatesDisabled(settings)) {
    return { kind: "unavailable", reason: "updates_disabled", detail: "DISABLE_UPDATES is set" };
  }
  const channel = settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
  const timeoutMs = Math.max(deadline - Date.now(), 1);
  if (resolved.method === "npm") {
    return withMinimum(await npmCheck(installed, channel, { url: `${from.npm}/${channel}`, timeoutMs }), settings.minimumVersion);
  }
  const url = `${from.releases}/${channel}`;
  const read = await readReleaseSource(url, timeoutMs);
  return read.ok ? withMinimum(comparedCheck(installed, read.text.trim(), url, channel), settings.minimumVersion) : read.check;
}

export function claudeUpdateCheck(from: ClaudeUpdateSources = sources): UpdateChecker {
  return async (installation: AvailableInstallation | VersionUnsupportedInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    if (installation.via === "executable" && DESKTOP_CACHE.test(installedPath(installation.command))) {
      return { kind: "unavailable", reason: "package_manager", detail: DESKTOP_OWNER };
    }
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    const deadline = Date.now() + (options.timeoutMs ?? CHECK_TIMEOUT_MS);
    const resolved = await resolveClaudeInstallMethod(installedPath(update.installation.command), from, Math.max(deadline - Date.now(), 0));
    return checkWithResolvedMethod(update.installed, resolved, from, deadline);
  };
}

export const claudeCheckUpdate = claudeUpdateCheck();

export function claudeUpgrader(from: ClaudeUpdateSources = sources): Upgrader {
  return async (installation: AvailableInstallation | VersionUnsupportedInstallation, options?: UpgradeOptions): Promise<UpgradeResult> => {
    if (installation.via !== "executable") {
      return upgradeExecutable(installation, { check: claudeUpdateCheck(from), args: ["update"], env: claudeEnv }, options);
    }
    const realPath = installedPath(installation.command);
    if (DESKTOP_CACHE.test(realPath)) {
      return { kind: "unsupported", reason: "unsupported_installation", detail: DESKTOP_OWNER };
    }
    const deadline = Date.now() + (options?.timeoutMs ?? CHECK_TIMEOUT_MS);
    const resolved = await resolveClaudeInstallMethod(realPath, from, Math.max(deadline - Date.now(), 0));
    const unavailable = unavailableForMethod(resolved);
    if (unavailable !== null && unavailable.kind === "unavailable") {
      return { kind: "unsupported", reason: "unsupported_installation", ...(unavailable.detail === undefined ? {} : { detail: unavailable.detail }) };
    }
    const check: UpdateChecker = async (current) => {
      const update = executableUpdate(current);
      if (update.kind === "unavailable") {
        return update.check;
      }
      const checked = await checkWithResolvedMethod(update.installed, resolved, from, deadline);
      return checked;
    };
    // Without the parent Claude Code session's markers, as every other claude OAR starts (environment.ts).
    return upgradeExecutable(installation, { check, args: ["update"], env: claudeEnv }, options);
  };
}

export const claudeUpgrade = claudeUpgrader();
