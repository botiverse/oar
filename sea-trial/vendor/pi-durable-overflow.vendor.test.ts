import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { statusOf } from "../../packages/oar/src/observe/agent-status.js";
import { startDurableFixture } from "../harness/pi-durable.js";

vi.mock("@earendil-works/pi-durable", async (importOriginal) => {
  const native = await importOriginal<{ watchEvents: typeof watchEvents }>();
  return { ...native, watchEvents: vi.fn(native.watchEvents) };
});

// Delay a real watch listener. The SDK itself supplies its bounded-backlog snapshot;
// neither the batch nor its terminal receipt is mocked.
test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock").each([false, true])("overflow recovery preserves observation when receipt query fails: %s", async (queryFails) => {
  const watch = vi.mocked(watchEvents);
  const nativeWatch = watch.getMockImplementation();
  assert.ok(nativeWatch);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let delayed = false;
  watch.mockImplementation(async (...args) => {
    const stream = await nativeWatch(...args);
    return { snapshot: stream.snapshot, closed: stream.closed, stop: async () =>  stream.stop(), start(listener) {
      stream.start(async (batch, context) => { if (delayed) { entered.resolve(); await gate.promise; } await listener(batch, context); });
    } };
  });
  const fixture = await startDurableFixture();
  try {
    const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
    await session.prompt("slow response");
    const conversations = await fixture.harness.commit(async (tx) =>  tx.scanConversations({}, 10), BACKGROUND_CONTEXT);
    const record = conversations.items.find((item) => String(item.id) === session.id);
    assert.ok(record);
    const conversation = await fixture.harness.conversation(record.id, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    delayed = true;
    await conversation.configure({ instructions: "block before abort" }, BACKGROUND_CONTEXT);
    await entered.promise;
    await conversation.abort(BACKGROUND_CONTEXT);
    for (let index = 0; index < 110; index += 1) { await conversation.configure({ instructions: `revision ${String(index)}` }, BACKGROUND_CONTEXT); }
    const failure = new Error("receipt query failed");
    if (queryFails) { vi.spyOn(fixture.harness, "submission").mockRejectedValueOnce(failure); }
    gate.resolve();
    if (queryFails) {
      await vi.waitFor(() => {
        const failed = session.records().find((entry) => entry.kind === "frame" && entry.body.type === "pi-durable/submissions_error");
        assert.ok(failed?.kind === "frame");
        expect(failed.body.native).toEqual({ message: "receipt query failed", error: failure });
      });
      const count = session.records().length;
      await conversation.configure({ instructions: "still watching" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => { expect(session.records().length).toBeGreaterThan(count); });
      expect(session.records().some((entry) => entry.kind === "response" && entry.body.kind === "exited")).toBe(false);
      await session.dispose();
      return;
    }
    await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
    expect(statusOf(session.records(), session.id)).toEqual(session.status());
    const frames = session.records().filter((entry) => entry.kind === "frame");
    expect(frames.filter((frame) => frame.body.type === "pi-durable/submissions")).toHaveLength(1);
    expect(frames.flatMap((frame) => frame.body.events).filter((event) => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
    await session.dispose();
  } finally { gate.resolve(); watch.mockImplementation(nativeWatch); await fixture.close(); }
});
