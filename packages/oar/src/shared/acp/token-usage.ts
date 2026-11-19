import type { RuntimeEventBody, TokenTotals } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../json.js";
import { acpPromptUsage } from "./projection.js";
import type { AcpSessionProfile } from "./profile.js";

/** One root accumulator shared by prompt replies and proven independent vendor reports. */
export interface AcpTokenUsage {
  prompt(response: JsonRecord): RuntimeEventBody | null;
  extension(method: string, params: JsonRecord, opened: boolean): RuntimeEventBody | null;
}

export function createAcpTokenUsage(profile: AcpSessionProfile, sentByOar: (promptId: string) => boolean = () => false): AcpTokenUsage {
  let billed: TokenTotals = { input: 0, output: 0 };
  const seen = new Set<string>();
  return {
    prompt(response) {
      const reading = acpPromptUsage(profile.promptContextUsage?.(response) ?? null, profile.promptTokenUsage?.(response) ?? null, billed);
      ({ billed } = reading);
      return reading.event;
    },
    extension(method, params, opened) {
      const report = profile.spontaneousTokenUsage?.(method, params, sentByOar);
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

/** Opt in only for runtimes whose standard ACP reply accounts for the whole prompt.
 * Total less output includes cached input regardless of how the vendor splits it.
 * agy 1.5.12 has only reported zero cache writes on the verified Gemini paths.
 */
export function wholePromptTokenUsage(response: JsonRecord): TokenTotals | null {
  const usage = asRecord(response.usage);
  if (usage === null) { return null; }
  const total = asNumber(usage.totalTokens);
  const output = asNumber(usage.outputTokens);
  const inputTokens = asNumber(usage.inputTokens);
  if (total === null || output === null || inputTokens === null || output < 0 || inputTokens < 0 || total - output < inputTokens) { return null; }
  const input = total - output;
  const read = asNumber(usage.cachedReadTokens);
  const thought = asNumber(usage.thoughtTokens);
  return {
    input, output,
    ...(read !== null && read >= 0 && read <= input ? { cacheRead: read } : {}),
    ...(usage.cachedWriteTokens === 0 ? { cacheWrite: 0 } : {}),
    ...(thought !== null && thought >= 0 && thought <= output ? { reasoning: thought } : {}),
  };
}
