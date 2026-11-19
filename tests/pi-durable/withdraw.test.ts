import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai-durable/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { createPiDurableRuntime } from "../../packages/oar/src/runtimes/pi-durable/index.js";
import { withdraw } from "../fixtures/withdraw.js";

const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(async (harness) => harness.close(BACKGROUND_CONTEXT))); });

// oxlint-disable-next-line max-statements -- Exercise concurrent queue+withdraw against an active durable run and verify only kept input runs.
test("concurrent pi-durable withdraw intercepts an in-flight queue before submission commits, while kept input still runs", async () => {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "plain" }] });
  faux.setResponses([
    async () => { await delay(120); return fauxAssistantMessage("turn-1"); },
    fauxAssistantMessage("turn-2-kept"),
    fauxAssistantMessage("turn-3-unexpected"),
  ]);
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  const runtime = createPiDurableRuntime({ harness, models });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "faux/plain" });
  try {
    const first = await session.prompt("one");
    const withdrawnId = "44444444-4444-4444-8444-444444444444";
    const keptId = "77777777-7777-4777-8777-777777777777";
    const [withdrawnQueue, withdrawnOutcome, keptQueue] = await Promise.all([
      session.queue("withdrawn", { inputId: withdrawnId }),
      withdraw(session, withdrawnId),
      session.queue("kept", { inputId: keptId }),
    ]);
    expect([withdrawnQueue.kind, withdrawnOutcome, keptQueue.kind]).toEqual(["accepted", "accepted", "accepted"]);
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await delay(30);
    const texts = session.records().flatMap(record => record.kind === "frame" ? record.body.events.flatMap(event => event.kind === "text_delta" ? [event.text] : []) : []);
    expect(texts).toEqual(["turn-1", "turn-2-kept"]);
    expect([...conversationOf(session.records()).inputs.values()].find(item => item.inputId === withdrawnId)?.state).toBe("withdrawn");

    const rejectedId = "88888888-8888-4888-8888-888888888888";
    const [rejectedQueue, rejectedWithdraw] = await Promise.all([
      session.queue("image", { inputId: rejectedId, images: [{ path: "/virtual/none.png" }] }),
      withdraw(session, rejectedId),
    ]);
    expect([rejectedQueue.kind, rejectedWithdraw]).toEqual(["rejected", "not_queued"]);
  } finally {
    await session.dispose();
  }
});
