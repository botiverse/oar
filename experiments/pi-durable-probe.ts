/**
 * Pi Durable 1.1.0, observed 2026-10-09: native run_end precedes terminal
 * submission receipts within the same batch. Instructions and requestId
 * deduplication survive JSONL close/open. No credentials or paid calls.
 * Run: pnpm tsx experiments/pi-durable-probe.ts > durable-native.jsonl
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";

const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100 });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("slow ".repeat(100)), fauxAssistantMessage("resumed reply")]);
const directory = await mkdtemp(join(tmpdir(), "oar-durable-"));
const storage = await openNodeJsonlStorage(directory, context);
const options = { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 0 } } };
const harness = await Harness.open(storage, options, context);
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "APPEND_MARKER", cwd: "/virtual" } }, context);
const stream = await watchEvents(harness, conversation.id, context);
process.stdout.write(`${JSON.stringify({ type: "initial", value: stream.snapshot })}\n`);
stream.start(async (events) => { process.stdout.write(`${JSON.stringify(events)}\n`); await Promise.resolve(); });
const first = await conversation.submit({ type: "input", requestId: "first", content: "first", whenBusy: "reject" }, context);
await first.wait(context);
const duplicate = await conversation.submit({ type: "input", requestId: "first", content: "different", whenBusy: "reject" }, context);
assert.equal(duplicate.id, first.id);
const slow = await conversation.submit({ type: "input", requestId: "slow", content: "slow", whenBusy: "reject" }, context);
const queued = await conversation.submit({ type: "input", requestId: "queued", content: "queued", whenBusy: "followUp" }, context);
assert.equal(await queued.abort(context), "aborted");
await conversation.abort(context);
process.stdout.write(`${JSON.stringify({ type: "abort", value: await slow.status(context) })}\n`);
await stream.stop();
await harness.close(context);
const reopened = await Harness.open(await openNodeJsonlStorage(directory, context), options, context);
const restored = await reopened.conversation(conversation.id, context);
assert.ok(restored);
process.stdout.write(`${JSON.stringify({ type: "restored", value: await restored.agent(context) })}\n`);
const restoredAgent = await restored.agent(context);
assert.equal(restoredAgent.instructions, "APPEND_MARKER");
const retry = await restored.submit({ type: "input", requestId: "first", content: "retry" }, context);
assert.equal(retry.id, first.id);
await reopened.close(context);
await rm(directory, { recursive: true, force: true });
