import { realpathSync } from "node:fs";
import type { AvailableInstallation, ExecutableInstallation } from "../contracts/installation.js";
import type { UpdateCheck, UpdateChecker, UpgradeOptions, UpgradeResult } from "../contracts/update.js";
import { readExecutableVersion, runIsolated, type IsolatedResult } from "./executable/index.js";
import { parseJson } from "./json.js";

export const CHECK_TIMEOUT_MS = 20_000;
const UPGRADE_TIMEOUT_MS = 600_000;
/** The slowest installation probes (cursor, kimi) allow 30 s for `--version`; a kimi start after an upgrade also swaps the staged binary in. */
const VERSION_TIMEOUT_MS = 30_000;

/** The release version inside a `--version` line or release pointer: a cursor date build or a semver. */
export function releaseVersion(text: string): string | undefined {
  return /\b\d{4}\.\d{2}\.\d{2}-[\da-f]+\b/u.exec(text)?.[0]
    ?? /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/u.exec(text)?.[0];
}

function numericParts(value: string): number[] {
  const release = value.split("-")[0] ?? "";
  return release.split(".").map(Number);
}

/** Numeric `major.minor.patch` order; prerelease tags are ignored. */
export function versionAtLeast(version: string, floor: string): boolean {
  const [left, right] = [numericParts(version), numericParts(floor)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

const SCRIPT_CONTEXT = /^npm_(?:config_user_agent|lifecycle_|package_|execpath$|node_execpath$|command$)/iu;

/**
 * The host environment without the markers a package script run (`npm run`,
 * `pnpm run`) adds: given `npm_config_user_agent`, grok 1.0.46 treats a
 * script install as npm-managed and installs a second copy. npm
 * configuration itself (such as the prefix) stays: npm-method updaters
 * should honor it, and the version read-back catches an update that went to
 * another prefix.
 */
export function updaterEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SCRIPT_CONTEXT.test(key)));
}

export type ExecutableUpdate =
  | { readonly kind: "executable"; readonly installation: ExecutableInstallation; readonly installed: string }
  | { readonly kind: "unavailable"; readonly check: UpdateCheck };

/** The executable and its installed release version, or why a check cannot start. */
export function executableUpdate(installation: AvailableInstallation): ExecutableUpdate {
  if (installation.via !== "executable") {
    return {
      kind: "unavailable",
      check: { kind: "unavailable", reason: "unsupported_installation", detail: "bundled with oar; it moves with the oar version" },
    };
  }
  const installed = installation.version === undefined ? undefined : releaseVersion(installation.version);
  if (installed === undefined) {
    return {
      kind: "unavailable",
      check: { kind: "unavailable", reason: "version_unreadable", detail: `${installation.command} --version gave no release version` },
    };
  }
  return { kind: "executable", installation, installed };
}

/** The executable's real path with `/` separators, for install-layout tests. */
export function installedPath(command: string): string {
  try {
    return realpathSync(command).replaceAll("\\", "/");
  } catch {
    return command.replaceAll("\\", "/");
  }
}

/** A check from an installed and a released version, when the runtime gives no verdict of its own. */
export function comparedCheck(installed: string, released: string, source: string, channel?: string): UpdateCheck {
  const latest = releaseVersion(released);
  if (latest === undefined) {
    return { kind: "unavailable", reason: "version_unreadable", detail: `no release version in ${JSON.stringify(released.slice(0, 80))}`, source };
  }
  return {
    kind: "ok",
    installed,
    latest,
    updateAvailable: latest !== installed,
    ...(channel === undefined ? {} : { channel }),
    source,
  };
}

/** GET one release source; failures come back as the check's `lookup_failed`. */
export async function readReleaseSource(
  url: string,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly check: UpdateCheck }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { ok: false, check: { kind: "unavailable", reason: "lookup_failed", detail: `HTTP ${String(response.status)}`, source: url } };
    }
    return { ok: true, text: await response.text() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, check: { kind: "unavailable", reason: "lookup_failed", detail, source: url } };
  }
}

/** Run one of the runtime's own check commands, read only, with the updater environment. */
export async function runCheckCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly result: IsolatedResult; readonly json: unknown }> {
  const result = await runIsolated(command, args, { env: updaterEnv(), timeoutMs });
  return { result, json: parseJson(result.stdout) };
}

async function versionNow(command: string): Promise<string | undefined> {
  try {
    const raw = await readExecutableVersion(command, VERSION_TIMEOUT_MS);
    return raw === undefined ? undefined : releaseVersion(raw);
  } catch {
    return undefined;
  }
}

export interface NativeUpdater {
  readonly check: UpdateChecker;
  /** The runtime's own non-interactive update command. */
  readonly args: readonly string[];
}

function runOutput(run: IsolatedResult, timeoutMs: number): string {
  const output = `${run.stdout}${run.stderr}`;
  return run.timedOut ? `${output}\n[oar: stopped the updater after ${String(timeoutMs)} ms]\n` : output;
}

/**
 * Check, then run the runtime's own updater on the same executable and judge
 * the outcome by the version it reports afterwards. The updater runs only
 * when the check does not already say the installation is current.
 */
export async function upgradeExecutable(
  installation: AvailableInstallation,
  updater: NativeUpdater,
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation", detail: "bundled with oar; it moves with the oar version" };
  }
  const check = await updater.check(installation, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  if (check.kind === "ok" && !check.updateAvailable) {
    return { kind: "current", version: check.installed, check };
  }
  const before = check.kind === "ok" ? check.installed : await versionNow(installation.command);
  const timeoutMs = options.timeoutMs ?? UPGRADE_TIMEOUT_MS;
  const run = await runIsolated(installation.command, updater.args, { env: updaterEnv(), timeoutMs });
  const output = runOutput(run, timeoutMs);
  const after = await versionNow(installation.command);
  if (before !== undefined && after !== undefined && after !== before) {
    return { kind: "upgraded", from: before, to: after, output };
  }
  if (run.exitCode !== 0 || after === undefined) {
    return { kind: "failed", exitCode: run.exitCode, output };
  }
  return { kind: "unchanged", version: after, output };
}
