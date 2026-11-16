import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, GenerationTask, hook, type ConversationView } from "@earendil-works/pi-durable";
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

nativeTest("initial projection failure detaches the already attached native observer", async () => {
  const fixture = await startDurableFixture();
  const native = fixture.harness.observeConversation.bind(fixture.harness);
  const detached = vi.fn();
  const observation = vi.spyOn(fixture.harness, "observeConversation").mockImplementation(async (...args) => {
    const result = await native(...args);
    return { ...result, get value(): ConversationView { throw new Error("initial view failed"); }, detach: () => { detached(); result.detach(); } };
  });
  try {
    await expect(fixture.runtime.session({ kind: "available", via: "bundled" }, options)).rejects.toThrow("initial view failed");
    expect(detached).toHaveBeenCalledOnce();
  } finally { observation.mockRestore(); await fixture.close(); }
});

// oxlint-disable-next-line max-statements -- The two native receipts and same-publication handover must be checked together.
nativeTest("a failed run and queued successor in the same publication have separate outcomes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await startDurableFixture(mock => {
    let first = true;
    mock.onMessage(/.*/u, async () => {
      if (!first) { return { content: "B answered" }; }
      first = false; entered.resolve(); await release.promise;
      return { status: 400, error: { type: "invalid_request_error", message: "A failed" } };
    });
  }, undefined, undefined, undefined, { afterFailedRun: "continue" });
  const publications: Parameters<Parameters<typeof fixture.harness.observeConversation>[1]["advance"]>[0][] = [];
  const native = fixture.harness.observeConversation.bind(fixture.harness);
  const observation = vi.spyOn(fixture.harness, "observeConversation").mockImplementation(async (id, observer, context, window) => native(id, {
    ...observer, advance(...args) { publications.push(args[0]); observer.advance(...args); },
  }, context, window));
  const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, options);
  try {
    await session.prompt("A"); await entered.promise;
    await session.queue("B"); release.resolve();
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    await session.dispose();
    const ends = session.records().flatMap(record => record.kind === "frame" ? record.body.events : []).filter(event => event.kind === "turn_ended");
    expect(ends).toHaveLength(2);
    expect(ends[0]?.outcome).toMatchObject({ kind: "failed", failure: "invalid_request" });
    expect(ends[0]?.outcome.kind === "failed" ? ends[0].outcome.reason : undefined).toContain("A failed");
    expect(ends[1]?.outcome).toEqual({ kind: "completed" });
    expect(publications.some(call => call.kind === "value" && call.ops.some(op => op[0] === "d" && op[1].join(".") === "docs.pi.live.run")
      && call.value.docs["pi.live"]?.run !== undefined)).toBe(true);
  } finally { release.resolve(); observation.mockRestore(); await session.dispose(); await fixture.close(); }
});
