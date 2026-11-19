import type { TokenTotals } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { compareSemver } from "../../shared/semver.js";
import { cacheParts, reasoningPart } from "../../shared/token-totals.js";
import { parseOpencodeRelease } from "./version.js";

/** From 2.0.22, the native ACP response sums root steps across one prompt. */
export function opencodePromptTokenUsage(response: JsonRecord, initialized: JsonRecord): TokenTotals | null {
  const version = asRecord(initialized.agentInfo)?.version;
  const release = typeof version === "string" ? parseOpencodeRelease(version) : undefined;
  if (release?.major !== 2 || (compareSemver(release.version, "2.0.22") ?? -1) < 0) { return null; }
  const usage = asRecord(response.usage);
  if (usage === null) { return null; }
  const rawInput = asNumber(usage.inputTokens);
  const rawOutput = asNumber(usage.outputTokens);
  if (rawInput === null || rawOutput === null || rawInput < 0 || rawOutput < 0) { return null; }
  const parts = [usage.cachedReadTokens, usage.cachedWriteTokens, usage.thoughtTokens];
  if (parts.some(part => part !== undefined && (asNumber(part) ?? -1) < 0)) { return null; }
  const cache = cacheParts(usage, { read: "cachedReadTokens", write: "cachedWriteTokens" });
  const thought = reasoningPart(usage, "thoughtTokens");
  const input = rawInput + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0);
  const output = rawOutput + (thought.reasoning ?? 0);
  return input + output === usage.totalTokens ? { input, output, ...cache, ...thought } : null;
}
