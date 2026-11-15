import assert from "node:assert/strict";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type ConversationId, type WatchEnd } from "@earendil-works/pi-durable";
import { startDurableFixture, type DurableFixture } from "../harness/pi-durable.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

import { captureDurableObserver, holdDurableObservation } from "./support/durable-observation.js";

/** Generous on purpose: a native submission settles on its own clock, past `vi.waitFor`'s 1 s default on slow CI runners (macOS). */
const WAIT = { timeout: 15_000 };


let prepare: ((fixture: DurableFixture) => void) | undefined = undefined;
const fixtures: DurableFixture[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) { release(); }
  prepare = undefined;
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) { await fixture.close(); }
});
async function setup(storage?: MemoryStorage): Promise<{ readonly fixture: DurableFixture; readonly session: Session }> {
  const fixture = await startDurableFixture(undefined, storage);
  fixtures.push(fixture);
  prepare?.(fixture);
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
  let release: (() => void) | undefined = undefined;
  prepare = fixture => { release = holdDurableObservation(fixture.harness); };
  const resume = (): void => { release?.(); };
  releases.push(resume);
  return resume;
}
const storageError = new Error("storage failed");
storageError.cause = storageError;

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
    await vi.waitFor(async () => { const receipt = await submission.status(BACKGROUND_CONTEXT); expect(receipt.status).toBe("done"); }, WAIT);
    expect(session.status().value.kind).toBe("running");
    const busy = await session.prompt("cannot start yet");
    expect(busy.response.body).toEqual({ kind: "rejected", code: "busy", reason: "busy" });
    const retry = await session.prompt("retry", { inputId });
    expect(retry.kind).toBe("accepted");
    expect(session.status().value.kind).toBe("running");
    expect(fixture.mock.getRequests()).toHaveLength(1);
    release();
    await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); }, WAIT);
    await session.dispose();
  });

  test("a native host close records watch provenance and ends the controller", async () => {
    const { fixture, session } = await setup();
    await session.prompt("slow response");
    await fixture.harness.close(BACKGROUND_CONTEXT);
    await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); }, WAIT);
    const closed = session.records().find((record) => record.kind === "frame" && record.body.type === "pi-durable/watch_closed");
    assert.ok(closed?.kind === "frame");
    expect(closed.body.native).toEqual({ kind: "failed", error: { name: "Error", message: "session closed" } });
    expect(session.records().filter((record) => record.kind === "response" && record.body.kind === "exited").map((record) => record.body)).toEqual([{ kind: "exited", code: null }]);
    const refused = await session.prompt("unreachable");
    expect(refused.response.body).toEqual({ kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    await session.dispose();
  });

  test("a native storage failure closes the watch with a JSON-safe cause", async () => {
    const storage = new MemoryStorage();
    const { session } = await setup(storage);
    const commit = vi.spyOn(storage, "commit").mockRejectedValueOnce(storageError);
    try {
      await session.prompt("cannot persist");
      await vi.waitFor(() => { expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(true); }, WAIT);
      const unreachable = await session.prompt("unreachable");
      expect(unreachable.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
      await session.dispose();
      // Exercise the persisted record format, including the native cyclic cause.
      const serialized = JSON.stringify(session.records());
      const persisted: unknown = JSON.parse(serialized);
      expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ body: {
        type: "pi-durable/watch_closed", native: { kind: "failed", error: { name: "Error", message: "storage failed" } }, events: [],
      } })]));
    } finally { commit.mockRestore(); }
  });

  test.each<WatchEnd>([{ kind: "stopped" }, { kind: "aborted" }, { kind: "ended" }, { kind: "listener_error", error: new Error("listener failed") }, { kind: "failed", error: storageError }])("unexpected observer end $kind rejects later controls", async (end) => {
    let captured: ReturnType<typeof captureDurableObserver> = {};
    prepare = fixture => { captured = captureDurableObserver(fixture.harness); };
    const { session } = await setup();
    assert.ok(captured.current);
    captured.current.end(end);
    await vi.waitFor(() => { expect(session.records().some(record => record.kind === "response" && record.body.kind === "exited")).toBe(true); }, WAIT);
    const refused = await session.abort();
    expect(refused.response.body).toEqual({ kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    const closed = session.records().find(record => record.kind === "frame" && record.body.type === "pi-durable/watch_closed");
    assert.ok(closed?.kind === "frame");
    const native = "error" in end ? { kind: end.kind, error: { name: "Error", message: end.error instanceof Error ? end.error.message : String(end.error) } } : end;
    expect(closed.body.native).toEqual(native);
    await session.dispose();
    const serialized = JSON.stringify(session.records());
    const persisted: unknown = JSON.parse(serialized);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: { type: "pi-durable/watch_closed", native, events: [] } }),
      expect.objectContaining({ body: { kind: "accepted" } }),
    ]));
  });
});
