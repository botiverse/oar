/**
 * Claude Code host runtime.
 *
 * Models: Claude Code accepts **aliases** and **full Anthropic API model names**
 * (docs: https://code.claude.com/docs/en/model-config — "model alias or model name";
 *  any name starting with `claude-` is recognized on the Anthropic API).
 * There is no reliable machine `claude models` list; raft treats claude as a
 * **static** catalog (`STATIC_RUNTIME_MODEL_SOURCE_IDS` + `RUNTIME_MODELS.claude`).
 *
 * Catalog shape (aligned with raft `RUNTIME_MODELS.claude` + Code model aliases):
 * - aliases: default, best, fable, sonnet, opus, haiku, sonnet[1m], opus[1m], opusplan
 * - full IDs: claude-opus-5, claude-fable-5, claude-sonnet-5, …
 * - user-configured escape (zero options) for custom / gateway / env models
 * - optional `CLAUDE_MODEL_LIST=id1,id2` extends the list (host override)
 *
 * Fixture: fixtures/claude-models.sample.txt (ids one per line; same set as default catalog).
 */
import { baseDriver, which, runText, firstLineVersion, modelsToInfo } from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";
import type { ModelInfo } from "../../../config/model.js";
import { model } from "../../../config/model.js";

/** Claude Code model aliases (code.claude.com/docs/en/model-config). */
export const CLAUDE_ALIASES: readonly { id: string; label: string }[] = [
  { id: "default", label: "Default (account / org recommended)" },
  { id: "best", label: "Best (Fable 5 when available, else latest Opus)" },
  { id: "fable", label: "Claude Fable (alias)" },
  { id: "opus", label: "Claude Opus (alias → latest)" },
  { id: "sonnet", label: "Claude Sonnet (alias → latest)" },
  { id: "haiku", label: "Claude Haiku (alias → latest)" },
  { id: "sonnet[1m]", label: "Sonnet 1M context" },
  { id: "opus[1m]", label: "Opus 1M context" },
  { id: "opusplan", label: "Opus plan → Sonnet execute" },
];

/**
 * Full Anthropic API model IDs commonly used with Claude Code.
 * Mirrors raft `RUNTIME_MODELS.claude` full-id rows + current platform overview.
 * Claude Code also accepts other `claude-*` IDs; those use user-configured.
 */
export const CLAUDE_API_MODELS: readonly { id: string; label: string }[] = [
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
];

const USER_CONFIGURED: ModelInfo = model(
  "user-configured",
  "User-configured (env / config file / full claude-* id)",
  [],
);

/** Default catalog ids (aliases + API names). */
export function defaultClaudeModelIds(): readonly string[] {
  return [...CLAUDE_ALIASES.map((m) => m.id), ...CLAUDE_API_MODELS.map((m) => m.id)];
}

/**
 * Build ModelInfo list for Claude Code.
 *
 * Sample catalog source (fixtures/claude-models.sample.txt — one id per line):
 * ```
 * opus
 * sonnet
 * claude-opus-5
 * claude-fable-5
 * user-configured
 * ```
 */
export function buildClaudeModels(extraIds: readonly string[] = []): readonly ModelInfo[] {
  const byId = new Map<string, { id: string; label: string }>();
  for (const m of CLAUDE_ALIASES) byId.set(m.id, m);
  for (const m of CLAUDE_API_MODELS) byId.set(m.id, m);
  for (const id of extraIds) {
    const t = id.trim();
    if (!t || byId.has(t)) continue;
    byId.set(t, { id: t, label: t });
  }

  const live = [...byId.values()].map((m) => ({
    id: m.id,
    label: m.label,
    // Effort levels: model-dependent; declare a common closed set for form width.
    // Full accuracy would need per-id tables (raft has partial data).
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const,
  }));

  const listed = modelsToInfo("claude", live);
  if (listed.some((m) => m.id === "user-configured")) return listed;
  return [...listed, USER_CONFIGURED];
}

export function claudeDriver(): RuntimeDriver {
  return baseDriver("claude", {
    detect: async () => {
      const path = which("claude");
      if (!path) return null;
      const r = runText(path, ["--version"], { timeoutMs: 10_000 });
      const v = firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
      return v ? { version: v } : { version: "claude" };
    },
    models: async () => {
      const fromEnv =
        process.env.CLAUDE_MODEL_LIST?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      return buildClaudeModels(fromEnv);
    },
  });
}
