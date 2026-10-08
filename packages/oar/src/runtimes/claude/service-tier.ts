import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Flags apply to this process only; user settings files are never edited. */
export function claudeServiceTierArgs(requested: string | undefined): readonly string[] {
  if (requested === undefined) { return []; }
  if (requested !== "fast" && requested !== "default") {
    throw new Error(`claude cannot apply serviceTier ${requested}; its tiers are default and fast (on supported models)`);
  }
  return ["--settings", JSON.stringify({ fastMode: requested === "fast" })];
}

/** Claude's native fast-mode status, including a temporary downgrade during cooldown. */
export function claudeServiceTierEvents(message: JsonRecord): RuntimeEventBody[] {
  const status = message.fast_mode_state;
  if (status === "on") { return [{ kind: "service_tier", serviceTier: "fast" }]; }
  if (status === "off" || status === "cooldown") { return [{ kind: "service_tier", serviceTier: "default" }]; }
  return [];
}

/** Initialization reports applied state; get_settings.effective.fastMode is only configuration intent. */
export function claudeServiceTierRefusal(requested: string, answer: JsonRecord): string | null {
  const response = asRecord(answer.response);
  const applied = asRecord(response?.response);
  const status = applied?.fast_mode_state;
  if (response?.subtype === "success" && status === (requested === "fast" ? "on" : "off")) { return null; }
  const actual = typeof status === "string" ? status : "unreported";
  const reason = response?.subtype === "success" ? applied?.fast_mode_disabled_reason : response?.error;
  return `claude reports fast_mode_state ${actual} although serviceTier ${requested} was requested${typeof reason === "string" ? ` (${reason})` : ""}`;
}
