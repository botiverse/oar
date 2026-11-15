/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/promise-function-async -- Standalone native ABI probe loaded from a selected package root. Runtime assertions compare the caller's actual result with the view and retired document. */
/**
 * node --experimental-import-meta-resolve nested.mjs <package-root> <output-json>
 * Native nested result versus conversation observation, using only a faux provider.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

assert.ok(process.argv[2] && process.argv[3]);
const base = pathToFileURL(resolve(process.argv[2], "package.json")).href;
const load = name => import(import.meta.resolve(name, base));
const durable = await load("@earendil-works/pi-durable");
const { BACKGROUND_CONTEXT: context } = await load("@earendil-works/chord/context");
const { createModels } = await load("@earendil-works/pi-ai/models");
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await load("@earendil-works/pi-ai/providers/faux");
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 1000 });
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("outer", {}, { id: "outer-call" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("completed"),
]);
const registry = durable.createRegistry();
let nestedResult = null;
registry.install(durable.defineExtension({ name: "nested-probe", tools: [
  durable.defineTool({
    name: "leaf", description: "leaf", parameters: { type: "object", properties: {} }, replay: "safe",
    structuredOutputSchema: { type: "object", properties: { exitCode: { type: "number" } }, required: ["exitCode"] },
    execute: () => ({ output: [{ type: "text", text: "leaf done" }], structuredOutput: { exitCode: 7 }, isError: true }),
  }),
  durable.defineTool({
    name: "outer", description: "outer", parameters: { type: "object", properties: {} }, replay: "safe",
    execute: async (_args, api, sourceContext) => {
      nestedResult = await api.executeTool("leaf", {}, sourceContext, { key: "leaf" });
      return { output: [{ type: "text", text: "outer done" }] };
    },
  }),
] }));
const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry }, context);
const frames = [];
let slot = null;
let lastSummary = null;
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
const observation = await harness.observeConversation(conversation.id, {
  advance(call) {
    frames.push(call);
    if (call.kind !== "value") { return; }
    for (const tool of call.value.docs["pi.live"].nestedTools ?? []) {
      slot = tool;
      if (tool.summary) { lastSummary = tool.summary; }
    }
  },
  end() {},
}, context);
try {
  const input = await conversation.submit({ type: "input", content: "test" }, context);
  await input.wait(context);
  await conversation.waitForIdle(context);
  assert.ok(slot);
  assert.equal(nestedResult.structuredOutput.exitCode, 7);
  const doc = await harness.snapshot(durable.NestedCallDoc, slot.parentTaskId, "leaf", context);
  const exitCodeInView = frames.some(frame => JSON.stringify(frame).includes("exitCode"));
  assert.equal(doc, undefined);
  assert.equal(exitCodeInView, false);
  const result = { nestedResult, lastSummary, postRunDocument: doc ?? null, conversationFrames: frames };
  await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ lastSummary, postRunDocument: doc ?? null, exitCodeInView, exitCodeInNativeToolResult: nestedResult.structuredOutput.exitCode }));
} finally { observation.detach(); await harness.close(context); }
