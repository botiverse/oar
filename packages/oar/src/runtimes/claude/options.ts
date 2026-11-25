import { UnsupportedOptionError } from "../../contracts/errors.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { semverAtLeast } from "../../shared/semver.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { dshOnlyRefusals, piOnlyRefusals } from "../../shared/session-options.js";

export const claudeRefusedSessionOptions: RefusedSessionOptions = {
  ...piOnlyRefusals,
  ...dshOnlyRefusals,
  goals: "Claude /goal is a prompt command, not a structured native goal control",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Claude turn's processes while its session stays usable",
  nativeMemoryDefault: "Claude Code has no configuration layer below user settings for a soft native-memory default",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "This adapter has no verified per-session switch to inherit native permission and sandbox settings",
};

/** Oldest verified combination of a native sdk attribution and a readable effective setting. */
export function claudeModelRequestRefusal(version?: string): RefusedSessionOptions {
  return semverAtLeast(version, "2.1.274") ? {} : { modelRequests: "Claude model request capture needs a verified installation of 2.1.274 or later" };
}

export function verifyClaudeModelRequestSetting(reported: JsonRecord | null, expected: string): void {
  const key = "OTEL_LOG_RAW_API_BODIES";
  const effective = asRecord(asRecord(reported?.effective)?.env)?.[key];
  if (effective === expected) { return; }
  const source: unknown = Array.isArray(reported?.sources) && effective !== undefined
    ? reported.sources.findLast((item: unknown) => asRecord(asRecord(asRecord(item)?.settings)?.env)?.[key] === effective)
    : undefined;
  const name = asRecord(source)?.source;
  const known = ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"];
  const origin = typeof name === "string" && known.includes(name) ? name : "unknown";
  throw new UnsupportedOptionError("modelRequests", `Claude could not confirm the request capture directory (source: ${origin})`);
}
