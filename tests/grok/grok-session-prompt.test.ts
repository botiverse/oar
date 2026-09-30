import { expect, test } from "vitest";
import { grokInitializeMeta, validateGrokOptions } from "../../packages/oar/src/runtimes/grok/session.js";

function prompts(options: { systemPrompt?: string; appendSystemPrompt?: string }): Record<string, unknown> {
  const { systemPromptOverride, rules } = grokInitializeMeta({ cwd: "/work", ...options });
  return { systemPromptOverride, rules };
}

// grok drops `rules` when an override is given, so the appended prompt is
// folded into the override instead of being sent where it would be ignored.
test("grok's initialize carries the prompts where grok applies them", () => {
  expect({
    none: prompts({}),
    system: prompts({ systemPrompt: "s" }),
    appended: prompts({ appendSystemPrompt: "a" }),
    both: prompts({ systemPrompt: "s", appendSystemPrompt: "a" }),
  }).toEqual({
    none: { systemPromptOverride: undefined, rules: undefined },
    system: { systemPromptOverride: "s", rules: undefined },
    appended: { systemPromptOverride: undefined, rules: "a" },
    both: { systemPromptOverride: "s\n\na", rules: undefined },
  });
});

// A loaded session keeps the rules it was created with; only an override applies.
test("grok refuses an appended prompt on resume unless a system prompt carries it", () => {
  expect(() => {
    validateGrokOptions({ cwd: "/work", resume: "earlier-id", appendSystemPrompt: "a" });
  }).toThrow("grok keeps a loaded session's own rules, so appendSystemPrompt cannot apply on resume without systemPrompt");
  for (const options of [
    { cwd: "/work", resume: "earlier-id", systemPrompt: "s", appendSystemPrompt: "a" },
    { cwd: "/work", resume: "earlier-id", systemPrompt: "s" },
    { cwd: "/work", appendSystemPrompt: "a" },
  ]) {
    expect(() => {
      validateGrokOptions(options);
    }).not.toThrow();
  }
});
