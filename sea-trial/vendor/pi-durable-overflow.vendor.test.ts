import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { statusOf } from "../../packages/oar/src/observe/agent-status.js";
import { startDurableFixture } from "../harness/pi-durable.js";
import { holdDurableObservation } from "./support/durable-observation.js";

const WAIT = { timeout: 15_000 };

test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock").each([false, true])("buffered native observations retain every frame; receipt failure=%s", async queryFails => {
  const fixture = await startDurableFixture();
  const release = holdDurableObservation(fixture.harness);
  try {
    const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
    await session.prompt("slow response");
    const conversations = await fixture.harness.commit(async tx => tx.scanConversations({}, 10), BACKGROUND_CONTEXT);
    const record = conversations.items.find(item => String(item.id) === session.id);
    assert.ok(record);
    const conversation = await fixture.harness.conversation(record.id, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    await conversation.abort(BACKGROUND_CONTEXT);
    for (let index = 0; index < 110; index += 1) { await conversation.configure({ instructions: `revision ${String(index)}` }, BACKGROUND_CONTEXT); }
    const failure = Object.assign(new Error("receipt query failed"), { code: "TEST_QUERY" });
    failure.cause = failure;
    if (queryFails) { vi.spyOn(fixture.harness, "submission").mockRejectedValue(failure); }
    release();
    if (queryFails) {
      await vi.waitFor(() => { expect(session.records().some(entry => entry.kind === "frame" && entry.body.type === "pi-durable/submissions_error")).toBe(true); }, WAIT);
      const serialized = JSON.stringify(session.records());
      const persisted: unknown = JSON.parse(serialized);
      expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ body: {
        type: "pi-durable/submissions_error", native: { name: "Error", message: "receipt query failed", code: "TEST_QUERY" }, events: [],
      } })]));
      const count = session.records().length;
      await conversation.configure({ instructions: "still watching" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => { expect(session.records().length).toBeGreaterThan(count); }, WAIT);
      expect(session.records().some(entry => entry.kind === "response" && entry.body.kind === "exited")).toBe(false);
      expect(session.records().flatMap(entry => entry.kind === "frame" ? entry.body.events : []).filter(event => event.kind === "turn_ended")).toEqual([]);
    } else {
      await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); }, WAIT);
      expect(statusOf(session.records(), session.id)).toEqual(session.status());
      const frames = session.records().filter(entry => entry.kind === "frame");
      expect(frames.filter(frame => frame.body.type === "pi-durable/view").length).toBeGreaterThanOrEqual(110);
      expect(frames.flatMap(frame => frame.body.events).filter(event => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
    }
    await session.dispose();
  } finally { release(); vi.restoreAllMocks(); await fixture.close(); }
});
