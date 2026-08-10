import { baseDriver, which, runText, firstLineVersion, modelsToInfo } from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";

/**
 * Claude model ids.
 *
 * No stable `claude models` machine list today — default catalog is a fixed
 * alias set (plus optional CLAUDE_MODEL_LIST env override, comma-separated).
 *
 * Sample (env override):
 * ```
 * CLAUDE_MODEL_LIST=sonnet,opus,haiku
 * ```
 * Parsed → ids: ["sonnet","opus","haiku"]
 *
 * Sample (default aliases, no env):
 * ```
 * sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default
 * ```
 */
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
      const fromEnv = process.env.CLAUDE_MODEL_LIST?.split(",").map((s) => s.trim()).filter(Boolean);
      const ids =
        fromEnv && fromEnv.length > 0
          ? fromEnv
          : ["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan", "default"];
      return modelsToInfo(
        "claude",
        ids.map((id) => ({
          id,
          label: id,
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
        })),
      );
    },
  });
}
