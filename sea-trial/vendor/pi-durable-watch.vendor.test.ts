import assert from "node:assert/strict";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents, type ConversationId, type WatchEnd } from "@earendil-works/pi-durable";
import { startDurableFixture, type DurableFixture } from "../harness/pi-durable.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

vi.mock("@earendil-works/pi-durable", async (importOriginal) => {
  const native = await importOriginal<{ watchEvents: typeof watchEvents }>();
  return { ...native, watchEvents: vi.fn(native.watchEvents) };
});
const watch = vi.mocked(watchEvents);
const nativeWatch = watch.getMockImplementation() ?? assert.fail("native watch implementation missing");
const fixtures: DurableFixture[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) { release(); }
  watch.mockImplementation(nativeWatch);
  for (const fixture of fixtures.splice(0)) { await fixture.close(); }
});
async function setup(): Promise<{ readonly fixture: DurableFixture; readonly session: Session }> {
  const fixture = await startDurableFixture();
  fixtures.push(fixture);
  const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/", model: "aimock/aimock-model" });
  return { fixture, session };
}
function isId(value: number): value is ConversationId { return Number.isSafeInteger(value) && value > 0; }
async function conversation(fixture: DurableFixture, session: Session) {
  const id = Number(session.id);
  assert.ok(isId(id));
  const value = await fixture.harness.conversation(id, BACKGROUND_CONTEXT);
  assert.ok(value);
  return value;
}
function delayWatch(): () => void {
  const gate = Promise.withResolvers<void>();
  releases.push(gate.resolve);
  watch.mockImplementation(async (...args) => {
    const stream = await nativeWatch(...args);
    return { snapshot: stream.snapshot, closed: stream.closed, stop: async () => stream.stop(), start(listener) {
      stream.start(async (batch, context) => { await gate.promise; await listener(batch, context); });
    } };
  });
  return gate.resolve;
}
const suite = describe.skipIf(process.env.OAR_TEST !== "pi-durable-aimock");
suite("Pi Durable watch boundaries", () => {
  test("locally idle prompt sees an unobserved native run as runtime_refused, not busy", async () => {
    delayWatch();
    const { fixture, session } = await setup();
    const native = await conversation(fixture, session);
    await native.submit({ type: "input", content: "slow response", whenBusy: "reject" }, BACKGROUND_CONTEXT);
    expect(session.status().value.kind).toBe("idle");
    const result = await session.prompt("raced");
    assert.equal(result.kind, "rejected");
    expect(result.code).toBe("runtime_refused");
    // Exercise the persisted JSON format, not an in-memory structured clone.
    const serialized = JSON.stringify(session.records());
    const persisted: unknown = JSON.parse(serialized);
    expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ body: {
      kind: "rejected", code: "runtime_refused", reason: result.reason, native: { name: "ConversationBusy", message: result.reason },
    } })]));
  });

  test("locally running prompt is busy even after native work ended, while duplicate ids stay accepted", async () => {
    const release = delayWatch();
    const { fixture, session } = await setup();
    const inputId = crypto.randomUUID();
    await session.prompt("hello", { inputId });
    const native = await conversation(fixture, session);
    const record = await fixture.harness.commit(async (tx) => tx.submissionByRequest(native.id, inputId), BACKGROUND_CONTEXT);
    assert.ok(record);
    const submission = await fixture.harness.submission(record.id, BACKGROUND_CONTEXT);
    assert.ok(submission);
    await vi.waitFor(async () => { const receipt = await submission.status(BACKGROUND_CONTEXT); expect(receipt.status).toBe("done"); });
    expect(session.status().value.kind).toBe("running");
    const busy = await session.prompt("cannot start yet");
    expect(busy.response.body).toEqual({ kind: "rejected", code: "busy", reason: "busy" });
    const retry = await session.prompt("retry", { inputId });
    expect(retry.kind).toBe("accepted");
    expect(session.status().value.kind).toBe("running");
    expect(fixture.mock.getRequests()).toHaveLength(1);
    release();
    await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
    await session.dispose();
  });

  test("a native host close records watch provenance and ends the controller", async () => {
    const { fixture, session } = await setup();
    await session.prompt("slow response");
    await fixture.harness.close(BACKGROUND_CONTEXT);
    await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
    const closed = session.records().find((record) => record.kind === "frame" && record.body.type === "pi-durable/watch_closed");
    assert.ok(closed?.kind === "frame");
    expect(closed.body.native).toEqual({ reason: "session_closed" });
    expect(session.records().filter((record) => record.kind === "response" && record.body.kind === "exited").map((record) => record.body)).toEqual([{ kind: "exited", code: null }]);
    const refused = await session.prompt("unreachable");
    expect(refused.response.body).toEqual({ kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    await session.dispose();
  });

  test.each<WatchEnd>([{ reason: "stopped" }, { reason: "cancelled" }, { reason: "retired" }, { reason: "listener_error", error: new Error("listener failed") }])("unexpected watch end $reason rejects later controls", async (end) => {
    const ended = Promise.withResolvers<WatchEnd>();
    watch.mockImplementation(async (...args) => {
      const stream = await nativeWatch(...args);
      return { snapshot: stream.snapshot, closed: ended.promise, start: stream.start.bind(stream), stop: async () => { await stream.stop(); const result = await ended.promise; return result; } };
    });
    const { session } = await setup();
    ended.resolve(end);
    await vi.waitFor(() => { expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(true); });
    const refused = await session.abort();
    expect(refused.response.body).toEqual({ kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    const closed = session.records().find((record) => record.kind === "frame" && record.body.type === "pi-durable/watch_closed");
    assert.ok(closed?.kind === "frame");
    const native = end.reason === "listener_error" ? { reason: "listener_error", error: { name: "Error", message: "listener failed" } } : end;
    expect(closed.body.native).toEqual(native);
    await session.dispose();
    // Exercise the persisted JSON format, not an in-memory structured clone.
    const serialized = JSON.stringify(session.records());
    const persisted: unknown = JSON.parse(serialized);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: { type: "pi-durable/watch_closed", native, events: [] } }),
      expect.objectContaining({ body: { kind: "accepted", native } }),
    ]));
  });
});
