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
} from "../../shared/update.js";

/**
 * Claude has no check-only command, so the check reads what `claude update`
 * reads (claude 2.1.286): the native build follows
 * `downloads.claude.ai/claude-code-releases/<channel>`, an npm copy the npm
 * dist-tag of the same channel; the channel is settings `autoUpdatesChannel`
 * (`latest` unless `stable`). Package-manager copies update through their
 * package manager, and `DISABLE_UPDATES` turns every update path off.
 */
export interface ClaudeUpdateSources {
  readonly releases: string;
  readonly npm: string;
  readonly configDir: () => string;
}

const sources: ClaudeUpdateSources = {
  releases: "https://downloads.claude.ai/claude-code-releases",
  npm: "https://registry.npmjs.org/@anthropic-ai/claude-code",
  configDir: () => process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
};

const PACKAGE_MANAGED = ["/Caskroom/", "/Cellar/", "/mise/", "/asdf/", "/WinGet/", "/winget/"];

export function claudeInstallMethod(realPath: string): "native" | "npm" | "package_manager" {
  if (realPath.includes("/node_modules/@anthropic-ai/claude-code/")) {
    return "npm";
  }
  return PACKAGE_MANAGED.some((segment) => realPath.includes(segment)) ? "package_manager" : "native";
}

function claudeSettings(configDir: string): Record<string, unknown> {
  try {
    const text = readFileSync(path.join(configDir, "settings.json"), "utf8");
    return asRecord(parseJson(text)) ?? {};
  } catch {
    return {};
  }
}

function updatesDisabled(settings: Record<string, unknown>): boolean {
  const flag = process.env.DISABLE_UPDATES ?? asRecord(settings.env)?.DISABLE_UPDATES;
  return flag !== undefined && flag !== "" && flag !== "0" && flag !== false;
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
    const method = claudeInstallMethod(installedPath(update.installation.command));
    if (method === "package_manager") {
      return { kind: "unavailable", reason: "package_manager", detail: "this copy updates through its package manager" };
    }
    const settings = claudeSettings(from.configDir());
    if (updatesDisabled(settings)) {
      return { kind: "unavailable", reason: "updates_disabled", detail: "DISABLE_UPDATES is set" };
    }
    const channel = settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
    const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    if (method === "npm") {
      return npmCheck(update.installed, channel, { url: `${from.npm}/${channel}`, timeoutMs });
    }
    const url = `${from.releases}/${channel}`;
    const read = await readReleaseSource(url, timeoutMs);
    return read.ok ? comparedCheck(update.installed, read.text.trim(), url, channel) : read.check;
  };
}

export const claudeCheckUpdate = claudeUpdateCheck();

export async function claudeUpgrade(installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> {
  const result = await upgradeExecutable(installation, { check: claudeCheckUpdate, args: ["update"] }, options);
  return result;
}
