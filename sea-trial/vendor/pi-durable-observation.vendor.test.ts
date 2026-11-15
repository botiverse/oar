import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { startDurableFixture } from "../harness/pi-durable.js";

const nativeTest = test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock");
const options = { cwd: "/virtual", model: "aimock/aimock-model" };

nativeTest("callbacks before attachment resolves follow the initial snapshot without losing an entire run", async () => {
  const fixture = await startDurableFixture();
  const native = fixture.harness.observeConversation.bind(fixture.harness);
  const observation = vi.spyOn(fixture.harness, "observeConversation").mockImplementation(async (id, observer, context, window) => {
    const result = await native(id, observer, context, window);
    const conversation = await fixture.harness.conversation(id, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const input = await conversation.submit({ type: "input", content: "before attachment resolved" }, BACKGROUND_CONTEXT);
    await input.wait(BACKGROUND_CONTEXT);
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    return result;
  });
  let session: Session | undefined = undefined;
  try {
    session = await fixture.runtime.session({ kind: "available", via: "bundled" }, options);
    await session.dispose();
    const frames = session.records().flatMap(record => record.kind === "frame" ? [record.body] : []);
    expect(frames[0]?.type).toBe("snapshot");
    const events = frames.flatMap(frame => frame.events);
    expect(events.filter(event => event.kind === "turn_active")).toHaveLength(1);
    expect(events.filter(event => event.kind === "text_delta").map(event => event.text).join("")).toBe("ok");
    expect(events.filter(event => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    expect(session.records().some(record => record.kind === "request" && record.body.kind === "prompt")).toBe(false);
  } finally { observation.mockRestore(); await session?.dispose(); await fixture.close(); }
});

nativeTest("afterRun work keeps both original and newly attached controllers busy after the input is answered", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registry = createRegistry();
  registry.install(defineExtension({ name: "after-run", hooks: [hook(GenerationTask, { afterRun: async () => { entered.resolve(); await release.promise; } })] }));
  const fixture = await startDurableFixture(undefined, undefined, registry);
  let session: Session | undefined = undefined;
  let adopted: Session | undefined = undefined;
  try {
    session = await fixture.runtime.session({ kind: "available", via: "bundled" }, options);
    const first = await session.prompt("answer before afterRun ends");
    await entered.promise;
    adopted = await fixture.runtime.session({ kind: "available", via: "bundled" }, { ...options, resume: session.id });
    for (const controller of [session, adopted]) {
      expect(controller.status().value.kind).toBe("running");
      expect(controller.records().flatMap(record => record.kind === "frame" ? record.body.events : []).filter(event => event.kind === "turn_ended")).toHaveLength(0);
      const busy = await controller.prompt("must not interrupt afterRun");
      expect(busy).toMatchObject({ kind: "rejected", code: "busy" });
    }
    release.resolve();
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    await adopted.dispose();
    expect(adopted.status().value.kind).toBe("idle");
    const ends = adopted.records().flatMap(record => record.kind === "frame" ? record.body.events : []).filter(event => event.kind === "turn_ended");
    expect(ends).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    expect(fixture.mock.getRequests()).toHaveLength(1);
  } finally { release.resolve(); await adopted?.dispose(); await session?.dispose(); await fixture.close(); }
});
