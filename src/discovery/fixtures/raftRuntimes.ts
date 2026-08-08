/**
 * Offline fixtures aligned to Raft registry:
 * packages/daemon/src/drivers/index.ts driverFactories (12 ids)
 * packages/shared RUNTIMES (same 12; kimi + gemini deprecated for new agents)
 *
 * Form width follows design tiers — not full harness config surface.
 */

import type { RuntimeDescriptor } from "../detect.js";
import { boolOpt, enumOpt, model } from "../../config/model.js";

/** Authoritative registry ids — must match daemon driverFactories keys. */
export const RAFT_DRIVER_REGISTRY = [
  "builtin",
  "claude",
  "codex",
  "grok",
  "antigravity",
  "copilot",
  "cursor",
  "gemini",
  "kimi",
  "kimi-sdk",
  "opencode",
  "pi",
] as const;

export const RAFT_DEPRECATED_FOR_CREATE = ["kimi", "gemini"] as const;

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
        model("opus", "Opus", [reasoning(["low", "medium", "high"]), fast()]),
        model("sonnet", "Sonnet", [reasoning(["low", "medium", "high"]), fast()]),
        model("haiku", "Haiku", [reasoning(["low", "medium", "high"])]),
        model("user-configured", "User-configured (env / config file)", []),
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
      runtime: "builtin",
      label: "Built-in Pi",
      version: "fixture-1",
      models: [
        model("deepseek-chat", "DeepSeek Chat", [reasoning([...THINKING])]),
        model("deepseek-reasoner", "DeepSeek Reasoner", [reasoning([...THINKING])]),
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
      runtime: "kimi-sdk",
      label: "Kimi Code",
      version: "fixture-1",
      models: [
        model("kimi-k2", "Kimi K2", []),
        model("kimi-latest", "Kimi Latest", []),
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
    // Deprecated — still in registry; fixtures include them so ledger can close at 12.
    // Create form excludes them (same as Raft isRuntimeSelectableForNewAgent).
    {
      runtime: "kimi",
      label: "Kimi CLI (deprecated)",
      version: "fixture-1",
      models: [model("kimi-k2", "Kimi K2", [])],
    },
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
