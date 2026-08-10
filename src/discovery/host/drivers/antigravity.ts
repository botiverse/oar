import {
  baseDriver,
  versionVia,
  which,
  runText,
  looksLikeNeedsLogin,
  ModelsProbeError,
  modelsOnly,
} from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";

/**
 * Parse `agy models` stdout.
 *
 * Fixtures (same samples parser tests load):
 * - fixtures/agy-models.sample.txt        — live host, id glued to label
 * - fixtures/agy-models-spaced.sample.txt — spaced columns (xxchan sample)
 *
 * Live sample shape (TAB between id and label — fixtures/agy-models.sample.txt):
 * ```
 * gemini-3.6-flash-high\tGemini 3.6 Flash (High)
 * claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
 * ```
 * Spaced sample shape (fixtures/agy-models-spaced.sample.txt):
 * ```
 * gemini-3.6-flash-high     Gemini 3.6 Flash (High)
 * ```
 */
export function parseAgyModelsOutput(text: string): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /error|warning|please|sign|fetching/i.test(t)) continue;
    const bullet = t.match(/^[\*\-•]\s+(\S+)(?:\s+(.+))?$/);
    if (bullet?.[1]) {
      out.push({ id: bullet[1], label: (bullet[2] ?? bullet[1]).trim() });
      continue;
    }
    // id then label separated by tab or 2+ spaces
    const split = t.match(/^(\S+)[\t ]{1,}(.+)$/);
    if (split?.[1] && split[2] && /[A-Za-z]/.test(split[2])) {
      out.push({ id: split[1], label: split[2].trim() });
      continue;
    }
    // rare glue: "gemini-3.6-flash-highGemini …" (no separator)
    const glued = t.match(/^([a-z0-9][a-z0-9._-]*)([A-Z].+)$/);
    if (glued?.[1] && glued[2]) {
      out.push({ id: glued[1], label: glued[2].trim() });
    }
  }
  return out;
}

export function antigravityDriver(): RuntimeDriver {
  return baseDriver("antigravity", {
    detect: async () => versionVia("agy"),
    models: async () => {
      const path = which("agy");
      if (!path) return [];
      const r = runText(path, ["models"], { timeoutMs: 20_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      if (looksLikeNeedsLogin(text)) {
        throw new ModelsProbeError(
          "needs_login",
          (text.trim().split(/\r?\n/).find(Boolean) ?? "agy models requires sign-in").slice(0, 240),
        );
      }
      if (r.code !== 0 && !r.stdout.trim()) {
        throw new ModelsProbeError(
          "models_unavailable",
          text.trim().slice(0, 240) || `agy models exit ${String(r.code)}`,
        );
      }
      const rows = parseAgyModelsOutput(text);
      return modelsOnly(rows);
    },
  });
}
