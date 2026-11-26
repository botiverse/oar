/* oxlint-disable max-statements -- Each test drives real durable harness state transitions and checks resulting records. */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai-durable/providers/faux";
import { createRegistry, Harness, MemoryStorage, type Conversation, type Submission, type SubmissionDraft } from "@earendil-works/pi-durable";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { createPiDurableRuntime } from "../../packages/oar/src/runtimes/pi-durable/index.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.close(BACKGROUND_CONTEXT)));
});

async function openDurable(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], beforeSession?: (harness: Harness) => void) {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "plain" }] });
  faux.setResponses(responses);
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  beforeSession?.(harness);
  const runtime = createPiDurableRuntime({ harness, models });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "faux/plain" });
  return { harness, session };
}

test("Pi Durable idle steer checks no_active_turn before images and duplicate inputId", async () => {
  const { session } = await openDurable([fauxAssistantMessage("done")]);
  try {
    const duplicateId = "11111111-1111-4111-8111-111111111111";
    const first = await session.prompt("hello", { inputId: duplicateId });
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    const dupSteer = await session.steer?.("again", { inputId: duplicateId });
    expect(dupSteer?.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    const imageSteer = await session.steer?.("with-image", { images: [{ path: "/virtual/a.png" }] });
    expect(imageSteer?.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
  } finally { await session.dispose(); }
});

test("Pi Durable steer and abort immediately after prompt agree with running status and abort drops queued inputs", async () => {
  const gate = Promise.withResolvers<void>();
  const { harness, session } = await openDurable([
    async (_ctx, opts) => {
      opts?.signal?.addEventListener("abort", () => { gate.resolve(); }, { once: true });
      await gate.promise;
      return fauxAssistantMessage("never");
    },
  ]);
  try {
    const queuedId = "22222222-2222-4222-8222-222222222222";
    const steeredId = "33333333-3333-4333-8333-333333333333";
    const first = await session.prompt("start");
    expect(first.kind).toBe("accepted");
    expect(session.status().value.kind).toBe("running");
    // Immediately after prompt() before waiting for async view drain: steer must not return no_active_turn.
    const steered = await session.steer?.("mid", { inputId: steeredId });
    expect(steered?.kind).toBe("accepted");
    const queued = await session.queue("later", { inputId: queuedId });
    expect(queued.kind).toBe("accepted");
    const aborted = await session.abort();
    expect(aborted.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "aborted" });
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await delay(20);
    const dropped = session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "input_dropped") : []);
    expect(dropped.some(e => e.inputId === queuedId && e.reason === "turn_interrupted")).toBe(true);
    expect(dropped.some(e => e.inputId === steeredId && e.reason === "turn_interrupted")).toBe(true);
    const inputs = [...conversationOf(session.records()).inputs.values()];
    expect(inputs.find(item => item.inputId === queuedId)?.state).toBe("dropped");
    expect(inputs.find(item => item.inputId === steeredId)?.state).toBe("dropped");
  } finally {
    gate.resolve();
    await session.dispose();
  }
});

function failFirstStatus(conversation: Conversation): void {
  const original: (submission: SubmissionDraft, context: Context) => Promise<Submission> = conversation.submit.bind(conversation);
  let failedOnce = false;
  async function wrapped(submission: SubmissionDraft, context: Context): Promise<Submission> {
    const submitted = await original(submission, context);
    if (!failedOnce) {
      failedOnce = true;
      vi.spyOn(submitted, "status").mockRejectedValueOnce(new Error("status read failed"));
    }
    return submitted;
  }
  Object.defineProperty(conversation, "submit", { value: wrapped, configurable: true });
}

test("Pi Durable submission.status failure after submit still accepts and records submissions_error", async () => {
  const { session } = await openDurable([fauxAssistantMessage("ok")], (harness) => {
    const create = harness.createConversation.bind(harness);
    vi.spyOn(harness, "createConversation").mockImplementationOnce(async (...args) => {
      const conversation = await create(...args);
      failFirstStatus(conversation);
      return conversation;
    });
  });
  try {
    const result = await session.prompt("hello");
    expect(result.response.body).toEqual({ kind: "accepted" });
    expect(session.records().some(r => r.kind === "frame" && r.body.type === "pi-durable/submissions_error")).toBe(true);
    expect(await awaitTurnEnd(session, result.seq)).toEqual({ kind: "completed" });
  } finally { await session.dispose(); }
});
