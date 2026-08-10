/**
 * Offline fixtures aligned to Raft registry:
 * External host runtimes for detect (pi is the sole Pi-stack id; packed builtin is not listed).
 *
 * Form width follows design tiers — not full harness config surface.
 */

import type { RuntimeDescriptor } from "../detect.js";
import { boolOpt, enumOpt, model } from "../../config/model.js";

/**
 * Host runtime ids for detect enumeration.
 * Product ids (pi, kimi) use SDK probe paths — not CLI binary names.
 * Bridge to raft-computer internal ids (builtin, kimi-sdk) is adapter-layer.
 */
export const RAFT_DRIVER_REGISTRY = [
  "claude",
  "codex",
  "grok",
  "antigravity",
  "copilot",
  "cursor",
  "gemini",
  "kimi",
  "opencode",
  "pi",
] as const;

export const RAFT_DEPRECATED_FOR_CREATE = ["gemini"] as const;

const REASONING_FULL = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_STD = ["low", "medium", "high"] as const;
const THINKING = ["minimal", "low", "medium", "high", "xhigh"] as const;

function reasoning(values: readonly string[] = REASONING_STD) {
  return enumOpt("reasoningEffort", "Reasoning", values);
}
function fast() {
  return boolOpt("fastMode", "Fast mode");
}

/**
 * Fixture descriptors as if detectAll just ran.
 * Deprecated runtimes are still "detected" but marked for exclusion from create enum
 * via the create-filter layer (same as Raft getCreatableRuntimeOptions).
 */
export function fixtureDescriptors(): readonly RuntimeDescriptor[] {
  return [
    {
      runtime: "claude",
      label: "Claude Code",
      version: "fixture-1",
      models: [
        model("opus", "Claude Opus", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("sonnet", "Claude Sonnet", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("haiku", "Claude Haiku", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("fable", "Claude Fable", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("claude-opus-5", "Claude Opus 5", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("claude-fable-5", "Claude Fable 5", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("claude-sonnet-5", "Claude Sonnet 5", [reasoning(["low", "medium", "high", "xhigh", "max"]), fast()]),
        model("user-configured", "User-configured (env / config file / full claude-* id)", []),
      ],
    },
    {
      runtime: "codex",
      label: "Codex CLI",
      version: "fixture-1",
      models: [
        model("gpt-5.6", "GPT-5.6", [reasoning([...REASONING_FULL]), fast()]),
        model("gpt-5.3-codex", "GPT-5.3 Codex", [reasoning([...REASONING_FULL]), fast()]),
        model("gpt-5", "GPT-5", [reasoning([...REASONING_STD]), fast()]),
        model("gpt-4.1", "GPT-4.1", []),
        model("user-configured", "User-configured (isolated config dir)", []),
      ],
    },
    {
      runtime: "grok",
      label: "Grok Build",
      version: "fixture-1",
      models: [
        model("grok-4", "Grok 4", [reasoning([...REASONING_STD])]),
        model("grok-3", "Grok 3", [reasoning([...REASONING_STD])]),
      ],
    },
    {
      runtime: "antigravity",
      label: "Antigravity CLI",
      version: "fixture-1",
      models: [
        model("gemini-2.5-pro", "Gemini 2.5 Pro", []),
        model("gemini-2.5-flash", "Gemini 2.5 Flash", []),
      ],
    },
    {
      runtime: "kimi",
      label: "Kimi Code",
      version: "fixture-1",
      models: [
        model("kimi-code/kimi-for-coding", "K2.7 Coding", []),
        model("kimi-code/k3", "K3", [enumOpt("reasoningEffort", "Reasoning", ["low", "high", "max"])]),
      ],
    },
    {
      runtime: "copilot",
      label: "Copilot CLI",
      version: "fixture-1",
      models: [
        model("gpt-4.1", "GPT-4.1", [reasoning([...REASONING_STD])]),
        model("claude-sonnet-4", "Claude Sonnet 4", [reasoning([...REASONING_STD])]),
      ],
    },
    {
      runtime: "cursor",
      label: "Cursor CLI",
      version: "fixture-1",
      models: [
        model("auto", "Auto", []),
        model("sonnet-4", "Sonnet 4", []),
        model("gpt-5", "GPT-5", []),
      ],
    },
    {
      runtime: "opencode",
      label: "OpenCode",
      version: "fixture-1",
      models: [
        model("openai/gpt-5", "OpenAI GPT-5", []),
        model("anthropic/claude-sonnet-4", "Anthropic Claude Sonnet 4", []),
        model("deepseek/deepseek-chat", "DeepSeek Chat", []),
        model("moonshotai/kimi-k2", "Kimi K2", []),
      ],
    },
    {
      runtime: "pi",
      label: "Pi",
      version: "fixture-1",
      models: [],
      providers: [
        {
          id: "deepseek",
          label: "DeepSeek",
          models: [
            model("deepseek-chat", "DeepSeek Chat", [
              enumOpt("thinkingLevel", "Thinking", [...THINKING]),
            ]),
            model("deepseek-reasoner", "DeepSeek Reasoner", [
              enumOpt("thinkingLevel", "Thinking", [...THINKING]),
            ]),
          ],
        },
        {
          id: "openai",
          label: "OpenAI",
          models: [
            model("gpt-4.1", "GPT-4.1", [
              enumOpt("thinkingLevel", "Thinking", ["low", "medium", "high"]),
            ]),
            model("o3", "o3", [
              enumOpt("thinkingLevel", "Thinking", ["low", "medium", "high"]),
            ]),
          ],
        },
        {
          id: "anthropic",
          label: "Anthropic",
          models: [
            model("claude-sonnet-4", "Claude Sonnet 4", [
              enumOpt("thinkingLevel", "Thinking", ["low", "medium", "high"]),
            ]),
          ],
        },
        {
          id: "google",
          label: "Google",
          models: [
            model("gemini-2.5-pro", "Gemini 2.5 Pro", [
              enumOpt("thinkingLevel", "Thinking", ["low", "medium", "high"]),
            ]),
          ],
        },
      ],
    },
    // Deprecated — still in registry; create form excludes them.
    {
      runtime: "gemini",
      label: "Gemini CLI (deprecated)",
      version: "fixture-1",
      models: [model("gemini-2.5-pro", "Gemini 2.5 Pro", [])],
    },
  ];
}

export function assertFixtureCoversRegistry(): void {
  const ids = new Set(fixtureDescriptors().map((d) => d.runtime));
  for (const id of RAFT_DRIVER_REGISTRY) {
    if (!ids.has(id)) {
      throw new Error(`fixture missing registry runtime: ${id}`);
    }
  }
  if (ids.size !== RAFT_DRIVER_REGISTRY.length) {
    throw new Error(
      `fixture size ${String(ids.size)} != registry ${String(RAFT_DRIVER_REGISTRY.length)}`,
    );
  }
}

/** Descriptors offered on create form (excludes deprecated). */
export function creatableDescriptors(): readonly RuntimeDescriptor[] {
  const dep = new Set<string>(RAFT_DEPRECATED_FOR_CREATE);
  return fixtureDescriptors().filter((d) => !dep.has(d.runtime));
}

export function deprecatedExcluded(): readonly {
  runtime: string;
  reason: "deprecated";
}[] {
  return RAFT_DEPRECATED_FOR_CREATE.map((runtime) => ({
    runtime,
    reason: "deprecated" as const,
  }));
}
