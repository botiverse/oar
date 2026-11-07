/* oxlint-disable max-statements -- Control dispatch, cancellation and the native reply independently in each race. */
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { ResponseBody } from "../../packages/oar/src/contracts/session.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { createAcpTurns } from "../../packages/oar/src/shared/acp/turns.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/profile.js";
import type { AcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import { profile } from "../fixtures/acp-session-support.js";

function setup(steerSupersedesPrompt = true) {
  const kernel = createSessionKernel("root");
  const native = Promise.withResolvers<object>();
  const send = vi.fn(async () => native.promise);
  const notify = vi.fn(async () => {});
  const transport = { spawned: Promise.resolve(), closed: false, exitCode: null, connection: { agent: { request: send, notify } } };
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The real turn driver needs only this controlled prompt/cancel transport.
  const runtime = transport as unknown as AcpProcess;
  const turns = createAcpTurns({ kernel, runtime, profile: profile({ steerSupersedesPrompt }),
    usageGate: createUsageUpdateGate(), capabilities: { images: true }, promptUsage: () => null });
  const ends = () => kernel.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_ended") : []);
  return { kernel, native, send, notify, transport, turns, ends };
}

for (const transition of ["settle", "abort"] as const) {
  test.each([false, true])(`steer rejects when the turn ${transition}s during spawn wait; images: %s`, async images => {
    const { kernel, native, send, notify, transport, turns, ends } = setup();
    await kernel.control({ kind: "prompt", input: "A" }, request => turns.begin(request, "A"));
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1); });
    const state = turns.active(); assert.ok(state);
    const spawn = Promise.withResolvers<void>(); transport.spawned = spawn.promise;
    // An ended turn is rejected before even checking an image path.
    const options = images ? { images: [{ path: "/not-read-after-turn-end.png" }] } : undefined;
    const steering = kernel.control({ kind: "steer", input: "B", ...options }, async () => turns.steer(state, "B", options, {}));
    await setImmediate(); expect(send).toHaveBeenCalledTimes(1);
    if (transition === "settle") {
      native.resolve({ stopReason: "end_turn" });
      await vi.waitFor(() => { expect(ends()).toHaveLength(1); });
    } else {
      expect(await turns.abort(state)).toEqual({ kind: "accepted" });
      expect(notify).toHaveBeenCalledWith("session/cancel", { sessionId: "root" });
      expect(ends()).toHaveLength(0);
    }
    spawn.resolve();
    try {
      const result = await steering;
      expect(result.response.body).toEqual({ kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      native.resolve({ stopReason: transition === "abort" ? "cancelled" : "end_turn" });
      await vi.waitFor(() => { expect(ends()).toHaveLength(1); });
    }
    expect(ends()).toEqual([{ kind: "turn_ended", outcome: { kind: transition === "abort" ? "aborted" : "completed" } }]);
    expect(turns.active()).toBeNull();
  });
}

test.each([false, true])("steer still sends when its original turn remains active; replacing: %s", async replacing => {
  const { kernel, native, send, transport, turns, ends } = setup(replacing);
  await kernel.control({ kind: "prompt", input: "A" }, request => turns.begin(request, "A"));
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1); });
  const state = turns.active(); assert.ok(state);
  const spawn = Promise.withResolvers<void>(); transport.spawned = spawn.promise;
  const steering = turns.steer(state, "B", undefined, {});
  await setImmediate(); expect(send).toHaveBeenCalledTimes(1);
  spawn.resolve(); expect(await steering).toEqual({ kind: "accepted" });
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2); });
  native.resolve({ stopReason: "end_turn" });
  await vi.waitFor(() => { expect(ends()).toHaveLength(1); });
  expect(turns.active()).toBeNull();
});

test("abort can interleave the two awaits even when spawned is already resolved", async () => {
  const { kernel, native, send, turns, ends } = setup();
  await kernel.control({ kind: "prompt", input: "A" }, request => turns.begin(request, "A"));
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1); });
  const state = turns.active(); assert.ok(state);
  const aborted = Promise.withResolvers<ResponseBody>();
  const steering = turns.steer(state, "B", undefined, {});
  // The outer await resumes first, then abort, then the transport's await.
  queueMicrotask(() => { aborted.resolve(turns.abort(state)); });
  try {
    expect(await aborted.promise).toEqual({ kind: "accepted" });
    expect(await steering).toEqual({ kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    native.resolve({ stopReason: "cancelled" });
    await vi.waitFor(() => { expect(ends()).toHaveLength(1); });
  }
  expect(ends()).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
});

test.each(["settle", "abort", "replace"] as const)("steer cannot cross %s at the transport's final spawn wait", async transition => {
  const { kernel, native, send, transport, turns, ends } = setup();
  await kernel.control({ kind: "prompt", input: "A" }, request => turns.begin(request, "A"));
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1); });
  const state = turns.active(); assert.ok(state);
  const dispatch = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const nextNative = Promise.withResolvers<object>();
  let reads = 0;
  // oxlint-disable-next-line typescript/promise-function-async -- A promise-valued property controls the two existing awaits without adding another.
  Object.defineProperty(transport, "spawned", { get() {
    reads += 1;
    if (reads !== 2) { return Promise.resolve(); }
    entered.resolve(); return dispatch.promise;
  } });
  const steering = turns.steer(state, "B", undefined, {});
  await entered.promise;
  if (transition === "abort") {
    expect(await turns.abort(state)).toEqual({ kind: "accepted" });
  } else {
    native.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => { expect(ends()).toHaveLength(1); });
    if (transition === "replace") {
      send.mockImplementationOnce(async () => nextNative.promise);
      await kernel.control({ kind: "prompt", input: "C" }, request => turns.begin(request, "C"));
      await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2); });
      expect(turns.active()).not.toBe(state);
    }
  }
  dispatch.resolve();
  try {
    expect(await steering).toEqual({ kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" });
    await setImmediate(); expect(send).toHaveBeenCalledTimes(transition === "replace" ? 2 : 1);
  } finally {
    native.resolve({ stopReason: "cancelled" });
    nextNative.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => { expect(ends()).toHaveLength(transition === "replace" ? 2 : 1); });
  }
});

test.each([1, 2])("runtime exit at spawn wait %s settles steer without a native prompt", async wait => {
  const { kernel, native, send, transport, turns, ends } = setup();
  await kernel.control({ kind: "prompt", input: "A" }, request => turns.begin(request, "A"));
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1); });
  const state = turns.active(); assert.ok(state);
  const entered = Promise.withResolvers<void>(), spawn = Promise.withResolvers<void>();
  let reads = 0;
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the controlled promise as a property, not another async function.
  Object.defineProperty(transport, "spawned", { get() {
    reads += 1;
    if (reads !== wait) { return Promise.resolve(); }
    entered.resolve(); return spawn.promise;
  } });
  const steering = turns.steer(state, "B", undefined, {});
  await entered.promise;
  transport.closed = true; turns.onExit(); spawn.resolve();
  expect(await steering).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  native.resolve({ stopReason: "end_turn" });
  await setImmediate(); await setImmediate();
  expect(send).toHaveBeenCalledTimes(1);
  expect(ends()).toHaveLength(0);
});

test("a synchronous SDK send failure rejects steer and leaves the original reply in charge", async () => {
  const { kernel, native, send, turns, ends } = setup();
  await kernel.control({ kind: "prompt", input: "A" }, request => turns.begin(request, "A"));
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1); });
  const state = turns.active(); assert.ok(state);
  send.mockImplementationOnce(() => { throw new Error("send failed"); });
  expect(await turns.steer(state, "B", undefined, {})).toEqual({ kind: "rejected", code: "error", reason: "send failed" });
  expect(state.pending.size).toBe(1);
  native.resolve({ stopReason: "end_turn" });
  await vi.waitFor(() => { expect(ends()).toHaveLength(1); });
  expect(ends()).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  expect(kernel.records().filter(record => record.kind === "frame")).toHaveLength(1);
});
