import type { RuntimeEventBody, TokenTotals } from "../../contracts/session.js";
import type { JsonRecord } from "../json.js";
import { acpPromptUsage } from "./projection.js";
import type { AcpSessionProfile } from "./profile.js";

/** One root accumulator shared by prompt replies and proven independent vendor reports. */
export interface AcpTokenUsage {
  prompt(response: JsonRecord): RuntimeEventBody | null;
  extension(method: string, params: JsonRecord, opened: boolean): RuntimeEventBody | null;
}

export function createAcpTokenUsage(profile: AcpSessionProfile): AcpTokenUsage {
  let billed: TokenTotals = { input: 0, output: 0 };
  const seen = new Set<string>();
  return {
    prompt(response) {
      const reading = acpPromptUsage(profile.promptContextUsage?.(response) ?? null, profile.promptTokenUsage?.(response) ?? null, billed);
      ({ billed } = reading);
      return reading.event;
    },
    extension(method, params, opened) {
      const report = profile.spontaneousTokenUsage?.(method, params);
      if (report === undefined || report === null || seen.has(report.key)) { return null; }
      seen.add(report.key);
      // Opening can replay old terminal reports. Remember their identity so
      // a later repeated delivery cannot turn history into a fresh charge.
      if (!opened || report.replayed === true) { return null; }
      const reading = acpPromptUsage(null, report.tokens, billed);
      ({ billed } = reading);
      return reading.event;
    },
  };
}
