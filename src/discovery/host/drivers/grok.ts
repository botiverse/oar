import { baseDriver, versionVia, which, runText, modelsToInfo } from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";

/**
 * Parse `grok models` stdout.
 *
 * Fixture (parser tests load the same file): fixtures/grok-models.sample.txt
 * Full sample includes login-state lines — that is what the parser faces:
 * ```
 * You are logged in with grok.com.
 *
 * Default model: grok-4.5
 *
 * Available models:
 *   * grok-4.5 (default)
 * ```
 * Parsed → ids: ["grok-4.5"]
 */
export function parseGrokModelsOutput(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const mm = line.match(/^\s*\*\s+(\S+)/);
    if (mm?.[1]) ids.push(mm[1]);
  }
  return ids;
}

export function grokDriver(): RuntimeDriver {
  return baseDriver("grok", {
    detect: async () => versionVia("grok", ["--version"]),
    models: async () => {
      const path = which("grok");
      if (!path) return [];
      const r = runText(path, ["models"], { timeoutMs: 15_000 });
      const ids = parseGrokModelsOutput(r.stdout + r.stderr);
      return modelsToInfo(
        "grok",
        ids.map((id) => ({ id, label: id, supportedReasoningEfforts: ["high", "medium", "low"] })),
      );
    },
  });
}
