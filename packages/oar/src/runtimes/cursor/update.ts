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
  runCheckCommand,
  upgradeExecutable,
} from "../../shared/update.js";

const SOURCE = "cursor-agent about --format json";

/**
 * cursor-agent 2026.09.28 reports `latestVersion` and a `latestStatus` of
 * `up_to_date`, `update_available`, `disabled` (the `static` channel) or
 * `unavailable` in `about --format json`, without a login. Builds before it
 * (2026.08.11) report neither; for them the check asks the release service
 * cursor-agent's own updater asks, for the configured channel.
 */
export function projectCursorAbout(installed: string, about: unknown): UpdateCheck {
  const fields = asRecord(about);
  const status = fields?.latestStatus;
  if (status === "disabled") {
    return { kind: "unavailable", reason: "updates_disabled", detail: "cursor-agent is on the static channel", source: SOURCE };
  }
  const latest = fields?.latestVersion;
  if (typeof latest !== "string" || status === "unavailable") {
    return { kind: "unavailable", reason: "lookup_failed", detail: "cursor-agent reports no latest version", source: SOURCE };
  }
  const check = comparedCheck(installed, latest, SOURCE);
  if (check.kind !== "ok") {
    return check;
  }
  if (status === "update_available" || status === "up_to_date") {
    return { ...check, updateAvailable: status === "update_available" };
  }
  return check;
}

export interface CursorUpdateSources {
  /** Connect RPC answering `{ channel }` with `{ version, url }`. */
  readonly releases: string;
  readonly configPath: () => string;
}

const sources: CursorUpdateSources = {
  releases: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCliDownloadUrl",
  configPath: () => path.join(homedir(), ".cursor", "cli-config.json"),
};

function cursorChannel(configPath: string): string {
  try {
    const channel = asRecord(parseJson(readFileSync(configPath, "utf8")))?.channel;
    return typeof channel === "string" && channel !== "" ? channel : "prod";
  } catch {
    return "prod";
  }
}

async function releaseServiceCheck(installed: string, from: CursorUpdateSources, timeoutMs: number): Promise<UpdateCheck> {
  const channel = cursorChannel(from.configPath());
  if (channel === "static") {
    return { kind: "unavailable", reason: "updates_disabled", detail: "cursor-agent is on the static channel" };
  }
  try {
    const response = await fetch(from.releases, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify({ channel }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const version = asRecord(parseJson(await response.text()))?.version;
    return response.ok && typeof version === "string"
      ? comparedCheck(installed, version, from.releases, channel)
      : { kind: "unavailable", reason: "lookup_failed", detail: `HTTP ${String(response.status)}`, source: from.releases };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "unavailable", reason: "lookup_failed", detail, source: from.releases };
  }
}

export function cursorUpdateCheck(from: CursorUpdateSources = sources): UpdateChecker {
  return async (installation: AvailableInstallation, options: UpdateCheckOptions = {}): Promise<UpdateCheck> => {
    const update = executableUpdate(installation);
    if (update.kind === "unavailable") {
      return update.check;
    }
    const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    const { json } = await runCheckCommand(update.installation.command, ["about", "--format", "json"], timeoutMs);
    const about = asRecord(json);
    if (about !== null && about.latestStatus === undefined && about.latestVersion === undefined) {
      return releaseServiceCheck(update.installed, from, timeoutMs);
    }
    return projectCursorAbout(update.installed, json);
  };
}

export const cursorCheckUpdate = cursorUpdateCheck();

export async function cursorUpgrade(installation: AvailableInstallation, options?: UpgradeOptions): Promise<UpgradeResult> {
  const result = await upgradeExecutable(installation, { check: cursorCheckUpdate, args: ["update"] }, options);
  return result;
}
