import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { orient, RuntimeRegistry } from "../../packages/oar/src/index.js";
import { createPiDurableRuntime } from "../../packages/oar/src/runtimes/pi-durable/index.js";
import { openConversation } from "../../packages/oar/src/runtimes/pi-durable/options.js";
import { SessionNotFoundError } from "../../packages/oar/src/contracts/session-not-found-error.js";

const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(async (harness) => harness.close(BACKGROUND_CONTEXT))); });
async function setup() {
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "reasoning", reasoning: true }, { id: "plain" }] }).provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  return { harness, models, runtime: createPiDurableRuntime({ harness, models }) };
}

test("a missing native conversation has a typed refusal and never creates a replacement", async () => {
  const { harness, runtime } = await setup();
  const installation = { kind: "available", via: "bundled" } as const;
  const opening = runtime.session(installation, { cwd: "/virtual", resume: "123" });
  await expect(opening).rejects.toBeInstanceOf(SessionNotFoundError);
  await expect(opening).rejects.toMatchObject({ sessionId: "123", cause: { method: "Harness.conversation", native: { id: 123, result: undefined } } });
  const records = await harness.commit(async (tx) => tx.scanConversations({}, 10), BACKGROUND_CONTEXT);
  expect(records.items).toHaveLength(0);
});

test("storage failure is preserved rather than classified as a missing conversation", async () => {
  const { harness, runtime } = await setup();
  const failure = new Error("storage is unavailable");
  vi.spyOn(harness, "conversation").mockRejectedValueOnce(failure);
  await expect(runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume: "123" })).rejects.toBe(failure);
});

test.each(["not-a-number", "01", "0"])("invalid resume id %s is refused before a native lookup", async (resume) => {
  const { harness, runtime } = await setup();
  const lookup = vi.spyOn(harness, "conversation");
  const opening = runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume });
  await expect(opening).rejects.toThrow();
  await expect(opening).rejects.not.toBeInstanceOf(SessionNotFoundError);
  expect(lookup).not.toHaveBeenCalled();
});

test("Pi Durable execution agrees with its opened session and survives placement requests", async () => {
  const { runtime } = await setup();
  expect(runtime.execution).toBe("in_process");
  for (const placement of ["auto", "shared", "isolated"] as const) {
    expect(runtime.withPlacement(placement).execution).toBe("in_process");
  }
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "faux/plain" });
  expect(session.placement).toBe(runtime.execution);
  await session.dispose();
});

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
          "provider": {
            "id": "faux",
          },
        },
        {
          "displayName": "plain",
          "id": "faux/plain",
          "provider": {
            "id": "faux",
          },
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

function catalog(id: string, reasoning = true) {
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id, reasoning }] }).provider);
  return models;
}

/* oxlint-disable max-statements -- Keep the catalog replacements and their before/after assertions in one scenario. */
test("a replaced model catalog is used for listing and new and resumed model validation", async () => {
  let current = catalog("before");
  const models = () => current;
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  const runtime = createPiDurableRuntime({ harness, models });
  const installation = { kind: "available", via: "bundled" } as const;
  const before = await runtime.listModels?.(installation);
  expect(before?.kind === "ok" && before.models.map((model) => model.id)).toEqual(["faux/before"]);
  const original = await runtime.session(installation, { cwd: "/virtual", model: "faux/before" });
  await original.dispose();

  current = catalog("after");
  const after = await runtime.listModels?.(installation);
  expect(after?.kind === "ok" && after.models.map((model) => model.id)).toEqual(["faux/after"]);
  /* oxlint-disable no-await-in-loop -- Finish and dispose each controller before opening the next on this Harness. */
  for (const resume of [undefined, original.id]) {
    const options = { cwd: "/virtual", ...(resume === undefined ? {} : { resume }) };
    await expect(runtime.session(installation, { ...options, model: "faux/before" })).rejects.toMatchObject({ failure: "model_unavailable" });
    const session = await runtime.session(installation, { ...options, model: "faux/after", effort: "high" });
    expect([session.model().value, session.effort().value]).toEqual(["faux/after", "high"]);
    await session.dispose();
  }
  /* oxlint-enable no-await-in-loop */
});

test("resumed effort validation follows a replacement catalog for the saved model", async () => {
  let current = catalog("same", false);
  const models = () => current;
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  const runtime = createPiDurableRuntime({ harness, models });
  const installation = { kind: "available", via: "bundled" } as const;
  const original = await runtime.session(installation, { cwd: "/virtual", model: "faux/same" });
  await original.dispose();
  const options = { cwd: "/virtual", resume: original.id, effort: "high" };
  await expect(runtime.session(installation, options)).rejects.toThrow("does not support effort high");
  current = catalog("same", true);
  const resumed = await runtime.session(installation, options);
  expect(resumed.effort().value).toBe("high");
  await resumed.dispose();
  current = catalog("same", false);
  await expect(runtime.session(installation, options)).rejects.toThrow("does not support effort high");
});
/* oxlint-enable max-statements */

test.each([
  { outputSchema: {} }, { systemPrompt: "replacement" }, { env: { TEST: "value" } }, { launchArgs: ["--flag"] }, { serviceTier: "fast" },
  { additionalDirectories: ["/extra"] }, { mcpServers: [{ name: "test", command: "unused" }] }, { disallowedTools: ["read"] }, { name: "named" },
])("declared option refusal happens before creating a conversation: %j", async (option) => {
  const { harness, runtime } = await setup();
  await expect(runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", ...option })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: Object.keys(option)[0] });
  const records = await harness.commit(async (tx) =>  tx.scanConversations({}, 10), BACKGROUND_CONTEXT);
  expect(records.items).toHaveLength(0);
});


test("orient keeps Pi Durable host catalog facts while direct readers refuse env", async () => {
  const { runtime } = await setup();
  const env = { HOME: "ignored-by-host-harness" };
  await expect(runtime.installation?.({ env })).rejects.toMatchObject({ option: "env" });
  const report = await orient(new RuntimeRegistry([runtime]), { depth: "models", env });
  expect(report.runtimes[0]?.installation).toMatchObject({ kind: "ok", value: { kind: "available", via: "bundled" } });
  expect(report.runtimes[0]?.models).toMatchObject({ kind: "ok", value: [{ id: "faux/reasoning" }, { id: "faux/plain" }] });
});
