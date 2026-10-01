import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { UpdateCheck, UpdateCheckOptions, UpdateChecker, UpgradeOptions, UpgradeResult } from "../../contracts/update.js";
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
}

const sources: ClaudeUpdateSources = {
  releases: "https://downloads.claude.ai/claude-code-releases",
  npm: "https://registry.npmjs.org/@anthropic-ai/claude-code",
  configDir: () => process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
  globalConfig: () => path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"),
};

const PACKAGE_MANAGED = ["/Caskroom/", "/Cellar/", "/mise/", "/asdf/", "/WinGet/", "/winget/"];

type ClaudeInstallMethod = "native" | "npm" | "package_manager";

/**
 * The layout decides where it is unambiguous (the native versions directory,
 * an npm package, a package manager's tree). A shim the path does not
 * explain (a pnpm bin, a Windows `claude.cmd`) falls back to the
 * `installMethod` claude recorded: `global` is its npm method.
 */
export function claudeInstallMethod(realPath: string, recorded?: unknown): ClaudeInstallMethod {
  if (realPath.includes("/claude/versions/")) {
    return "native";
  }
  if (realPath.includes("/node_modules/@anthropic-ai/claude-code/")) {
    return "npm";
  }
  if (PACKAGE_MANAGED.some((segment) => realPath.includes(segment))) {
    return "package_manager";
  }
  return recorded === "global" ? "npm" : "native";
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

export function claudeUpdateCheck(from: ClaudeUpdateSources = sources): UpdateChecker {
  return async (installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    const recorded = readJsonRecord(from.globalConfig()).installMethod;
    const method = claudeInstallMethod(installedPath(update.installation.command), recorded);
    if (method === "package_manager") {
      return { kind: "unavailable", reason: "package_manager", detail: "this copy updates through its package manager" };
    }
    const settings = readJsonRecord(path.join(from.configDir(), "settings.json"));
    if (updatesDisabled(settings)) {
      return { kind: "unavailable", reason: "updates_disabled", detail: "DISABLE_UPDATES is set" };
    }
    const channel = settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
    const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    if (method === "npm") {
      return withMinimum(await npmCheck(update.installed, channel, { url: `${from.npm}/${channel}`, timeoutMs }), settings.minimumVersion);
    }
    const url = `${from.releases}/${channel}`;
    const read = await readReleaseSource(url, timeoutMs);
    return read.ok ? withMinimum(comparedCheck(update.installed, read.text.trim(), url, channel), settings.minimumVersion) : read.check;
  };
}

export const claudeCheckUpdate = claudeUpdateCheck();

export async function claudeUpgrade(installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> {
  const result = await upgradeExecutable(installation, { check: claudeCheckUpdate, args: ["update"] }, options);
  return result;
}
