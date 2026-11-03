/* oxlint-disable max-statements -- Keep each native settlement, observer reentry and late cleanup in one ordered regression. */
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import type { ControlResult, Session } from "../../packages/oar/src/contracts/session.js";
import { piSession } from "../../packages/oar/src/runtimes/pi/session.js";
import { createPiRpcSession } from "../../packages/oar/src/runtimes/pi/rpc/session.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const mocks = vi.hoisted(() => ({ sdk: vi.fn(), rpc: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/pi/open.js", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), openPiAgentSession: mocks.sdk,
}));
vi.mock("../../packages/oar/src/runtimes/pi/rpc/open.js", () => ({ openPiRpc: mocks.rpc }));
afterEach(() => { vi.resetAllMocks(); });

/** Controllable native boundaries, including a reply that outlives its run. */
async function fixture(mode: "SDK" | "RPC", delayedReply = false) {
  const prompts: string[] = [];
  const runs: PromiseWithResolvers<void>[] = [];
  const reply = Promise.withResolvers<RpcResponse>();
  let emit: (event: Record<string, unknown>) => void = vi.fn<(event: Record<string, unknown>) => void>();
  const end = async (): Promise<void> => {
    emit({ type: "agent_end", messages: [] });
    emit({ type: "agent_settled", aborted: false });
    await settle();
  };
  const child = fakeLineProcess();
  const sdk = {
    sessionId: "pi", thinkingLevel: "off", model: undefined, isStreaming: false,
    extensionRunner: { emit: async (): Promise<void> => {} },
    getContextUsage: () => undefined,
    subscribe(listener: (event: Record<string, unknown>) => void) { emit = listener; return () => {}; },
    async prompt(input: string) {
      prompts.push(input);
      const run = Promise.withResolvers<void>(); runs.push(run);
      emit({ type: "agent_start" });
      await run.promise;
    },
    abort: end,
    dispose() {},
  };
  mocks.sdk.mockResolvedValue(sdk);
  mocks.rpc.mockImplementation(async (_options: unknown, _credentials: unknown, receive: (event: Record<string, unknown>) => void) => {
    emit = receive;
    return {
      child, directory: { path: "/fixture", remove() {} },
      state: { sessionId: "pi", thinkingLevel: "off", isStreaming: false, isCompacting: false,
        steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 },
      control: { request: async (command: RpcCommand): Promise<RpcResponse> => {
        if (command.type !== "prompt") { return { type: "response", command: command.type, success: false, error: "no stats in fixture" }; }
        prompts.push(command.message);
        // Keep B before agent_start in the delayed-reply cases. A late
        // handled/refused response for A must not release B's reservation.
        if (!delayedReply || prompts.length === 1) { emit({ type: "agent_start" }); }
        if (delayedReply && prompts.length === 1) { return reply.promise; }
        return { type: "response", command: "prompt", success: true, data: { disposition: "started" } };
      } },
    };
  });
  const start = mode === "SDK" ? piSession : createPiRpcSession({ execution: "subprocess" });
  const session = await start({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  return { session, prompts, runs, reply, end, close: async () => {
    child.end(0); await session.dispose(); for (const run of runs) { run.resolve(); }
    reply.resolve({ type: "response", command: "prompt", success: false, error: "fixture closed" });
  } };
}

function onFirstEnd(session: Session, observe: () => void): void {
  let ended = false;
  session.rawEvents(record => {
    if (ended || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
    ended = true; observe();
  });
}

test.each(["SDK", "RPC"] as const)("Pi %s accepts the next prompt in its terminal observer and keeps that new run busy", async mode => {
  const native = await fixture(mode); const { session } = native;
  const observed: { status: string; result: Promise<ControlResult> }[] = [];
  try {
    await session.prompt("A");
    onFirstEnd(session, () => { observed.push({ status: session.status().value.kind, result: session.prompt("B") }); });
    await native.end();
    expect(observed).toHaveLength(1); expect(observed[0]?.status).toBe("idle");
    expect(await observed[0]?.result).toMatchObject({ kind: "accepted" });
    expect(native.prompts).toEqual(["A", "B"]);
    expect(await session.prompt("cannot clear B")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(session.status().value.kind).toBe("running");
  } finally { await native.close(); }
});

test.each([
  ["SDK", "prompt"], ["SDK", "queue"], ["RPC", "prompt"], ["RPC", "queue"],
] as const)("Pi %s holds FIFO priority against observer %s", async (mode, control) => {
  const native = await fixture(mode); const { session } = native;
  const results: Promise<ControlResult>[] = [];
  try {
    await session.prompt("A"); await session.queue("B");
    onFirstEnd(session, () => { results.push(session[control]("C")); });
    await native.end();
    expect(results).toHaveLength(1);
    expect(await results[0]).toMatchObject(control === "prompt" ? { kind: "rejected", code: "busy" } : { kind: "accepted" });
    expect(native.prompts).toEqual(["A", "B"]);
    expect(session.records().flatMap(record => record.kind === "frame" ? [record.body.type] : []))
      .toEqual(["agent_start", "agent_end", "agent_settled", "agent_start"]);
    await native.end();
    expect(native.prompts).toEqual(control === "queue" ? ["A", "B", "C"] : ["A", "B"]);
  } finally { await native.close(); }
});

test("a late SDK prompt rejection cannot end the observer's new run", async () => {
  const native = await fixture("SDK"); const { session } = native;
  try {
    await session.prompt("A"); onFirstEnd(session, () => { void session.prompt("B"); });
    await native.end();
    expect(native.prompts).toEqual(["A", "B"]);
    native.runs[0]?.reject(new Error("old prompt rejection")); await settle();
    expect(session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toEqual([]);
    expect(await session.prompt("cannot clear B")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await native.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s held input also takes priority over observer compaction", async mode => {
  const native = await fixture(mode); const { session } = native;
  assert.ok(session.compact !== undefined);
  const compact = session.compact.bind(session);
  const results: ReturnType<typeof compact>[] = [];
  try {
    await session.prompt("A"); await session.queue("B");
    onFirstEnd(session, () => { results.push(compact()); });
    await native.end();
    expect(results).toHaveLength(1);
    expect(await results[0]).toMatchObject({ kind: "rejected", code: "busy" });
    expect(native.prompts).toEqual(["A", "B"]);
  } finally { await native.close(); }
});

test.each(["refused", "handled"] as const)("a late RPC %s response cannot release the observer's new run", async disposition => {
  const native = await fixture("RPC", true); const { session } = native;
  const observed: Promise<ControlResult>[] = [];
  try {
    const first = session.prompt("A"); await settle();
    onFirstEnd(session, () => { observed.push(session.prompt("B")); });
    await native.end();
    expect(observed).toHaveLength(1); expect(await observed[0]).toMatchObject({ kind: "accepted" });
    native.reply.resolve(disposition === "refused"
      ? { type: "response", command: "prompt", success: false, error: "old refusal" }
      : { type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
    expect(await first).toMatchObject({ kind: disposition === "refused" ? "rejected" : "accepted" });
    assert.deepEqual(native.prompts, ["A", "B"]);
    expect(await session.prompt("cannot clear B")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await native.close(); }
});
