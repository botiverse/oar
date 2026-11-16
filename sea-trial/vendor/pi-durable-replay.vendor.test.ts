import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, assertValidOp } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { startDurableFixture } from "../harness/pi-durable.js";

// oxlint-disable-next-line max-statements -- Compare each recorded revision against the corresponding independent native observation.
test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock")("one snapshot plus recorded deltas reconstructs every native revision", async () => {
  const fixture = await startDurableFixture();
  const views: ConversationView[] = [];
  const observe = fixture.harness.observeConversation.bind(fixture.harness);
  const spy = vi.spyOn(fixture.harness, "observeConversation").mockImplementation(async (id, observer, context, window) => {
    const result = await observe(id, { ...observer, advance(...args) { const [call] = args; if (call.kind === "value") { views.push(call.value); } observer.advance(...args); } }, context, window);
    views.unshift(result.value);
    return result;
  });
  const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
  try {
    await promptAndWait(session, "first");
    await promptAndWait(session, "second");
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    await session.dispose();
    const frames = session.records().flatMap(record => record.kind === "frame" && (record.body.type === "snapshot" || record.body.type === "pi-durable/view") ? [record.body] : []);
    expect(frames).toHaveLength(views.length);
    let replay: unknown = frames[0]?.native;
    expect(replay).toEqual(views[0]);
    for (const [index, frame] of frames.slice(1).entries()) {
      const { native } = frame;
      assert.ok(typeof native === "object" && native !== null && "ops" in native && Array.isArray(native.ops));
      expect(Object.keys(native).toSorted()).toEqual(["ops", "retired"]);
      const ops: unknown[] = native.ops;
      replay = applyImmutable(replay, ops.map(op => { assertValidOp(op); return op; }));
      expect(replay).toEqual(views[index + 1]);
    }
  } finally { spy.mockRestore(); await session.dispose(); await fixture.close(); }
});
