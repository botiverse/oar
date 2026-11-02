import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createPiRuntime } from "../packages/oar/src/runtimes/pi/index.js";
import { createPiDurableRuntime } from "../packages/oar/src/runtimes/pi-durable/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

// An added entry needs supplied/omitted native regressions, both before and after compaction.
test("the complete resume declaration inventory is measured and never declares a refused option", async () => {
  const models = createModels();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const runtimes = [
      ...allRuntimes.list().map((runtime) => ({ name: runtime.id, runtime })),
      { name: "pi-rpc", runtime: createPiRuntime({ execution: "subprocess" }) },
      { name: "pi-durable", runtime: createPiDurableRuntime({ harness, models }) },
    ];
    const declared = Object.fromEntries(runtimes.map(({ name, runtime }) => [name, runtime.resumedSessionOptions === undefined ? null : Object.keys(runtime.resumedSessionOptions).toSorted()]));
    expect(declared).toEqual({
      antigravity: null,
      claude: ["appendSystemPrompt", "systemPrompt"],
      codebuddy: null,
      codex: ["appendSystemPrompt", "systemPrompt"],
      cursor: null,
      grok: null,
      kimi: null,
      opencode: null,
      pi: ["appendSystemPrompt", "systemPrompt"],
      "pi-rpc": ["appendSystemPrompt", "systemPrompt"],
      "pi-durable": ["appendSystemPrompt"],
      qoder: null,
      qwen: ["appendSystemPrompt", "systemPrompt"],
    });
    for (const { name, runtime } of runtimes) {
      for (const key of Object.keys(runtime.resumedSessionOptions ?? {})) {
        expect(Object.keys(runtime.refusedSessionOptions ?? {}), `${name}.${key}`).not.toContain(key);
      }
    }
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
