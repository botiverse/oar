import { afterEach, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createPiDurableRuntime } from "../../packages/oar/src/runtimes/pi-durable/index.js";
import { openConversation } from "../../packages/oar/src/runtimes/pi-durable/options.js";

const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(async (harness) => harness.close(BACKGROUND_CONTEXT))); });
async function setup() {
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "reasoning", reasoning: true }, { id: "plain" }] }).provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  return { harness, models, runtime: createPiDurableRuntime({ harness, models }) };
}

test("model catalog, effort and native readback agree", async () => {
  const { runtime } = await setup();
  const installation = { kind: "available", via: "bundled" } as const;
  const list = await runtime.listModels?.(installation);
  expect(list).toMatchInlineSnapshot(`
    {
      "kind": "ok",
      "models": [
        {
          "displayName": "reasoning",
          "effortLevels": [
            "off",
            "minimal",
            "low",
            "medium",
            "high",
          ],
          "id": "faux/reasoning",
        },
        {
          "displayName": "plain",
          "id": "faux/plain",
        },
      ],
    }
  `);
  const session = await runtime.session(installation, { cwd: "/virtual", model: "faux/reasoning", effort: "high" });
  expect([session.model().value, session.effort().value]).toEqual(["faux/reasoning", "high"]);
  await session.dispose();
});

test("failed effort validation rolls back saved options on resume", async () => {
  const { harness, models } = await setup();
  const conversation = await openConversation(harness, models, { cwd: "/virtual", model: "faux/plain", appendSystemPrompt: "saved" });
  await expect(openConversation(harness, models, { cwd: "/changed", resume: String(conversation.id), effort: "high", appendSystemPrompt: "should roll back" })).rejects.toThrow("does not support effort high");
  const agent = await conversation.agent(BACKGROUND_CONTEXT);
  expect([agent.cwd, agent.instructions, agent.thinkingLevel]).toEqual(["/virtual", "saved", "off"]);
});

test.each([
  { systemPrompt: "replacement" }, { env: { TEST: "value" } }, { launchArgs: ["--flag"] }, { serviceTier: "fast" },
  { mcpServers: [{ name: "test", command: "unused" }] }, { disallowedTools: ["read"] },
])("declared option refusal happens before creating a conversation: %j", async (option) => {
  const { harness, runtime } = await setup();
  await expect(runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", ...option })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: Object.keys(option)[0] });
  const records = await harness.commit(async (tx) =>  tx.scanConversations({}, 10), BACKGROUND_CONTEXT);
  expect(records.items).toHaveLength(0);
});
