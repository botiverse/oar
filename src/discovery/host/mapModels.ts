/**
 * Map live model list entries → oar ModelInfo + ConfigOption options.
 */
import type { ModelInfo } from "../../config/model.js";
import { boolOpt, enumOpt, model } from "../../config/model.js";

export type LiveModel = {
  id: string;
  label?: string;
  supportedReasoningEfforts?: readonly string[];
  serviceTiers?: readonly string[];
  additionalSpeedTiers?: readonly string[];
};

const REASONING_RUNTIMES = new Set(["claude", "codex", "grok", "copilot", "pi"]);

export function modelsToInfo(runtime: string, models: readonly LiveModel[]): readonly ModelInfo[] {
  return models.map((m) => {
    const options = [];
    if (
      REASONING_RUNTIMES.has(runtime) &&
      m.supportedReasoningEfforts &&
      m.supportedReasoningEfforts.length > 0
    ) {
      options.push(enumOpt("reasoningEffort", "Reasoning", [...m.supportedReasoningEfforts]));
    }
    if (runtime === "claude") {
      options.push(boolOpt("fastMode", "Fast mode"));
    } else if (
      runtime === "codex" &&
      ((m.additionalSpeedTiers && m.additionalSpeedTiers.length > 0) ||
        m.serviceTiers?.includes("priority"))
    ) {
      options.push(boolOpt("fastMode", "Fast mode"));
    }
    return model(m.id, m.label ?? m.id, options);
  });
}

/** opencode / catalogs without uniform options */
export function modelsOnly(models: readonly LiveModel[]): readonly ModelInfo[] {
  return models.map((m) => model(m.id, m.label ?? m.id, []));
}
