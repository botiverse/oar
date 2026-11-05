/* oxlint-disable max-statements -- Native receipts and settlement are driven independently. */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { piSession } from "../../packages/oar/src/runtimes/pi/session.js";
import { createPiRpcSession } from "../../packages/oar/src/runtimes/pi/rpc/session.js";
import { turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import piPreflightFixture from "../fixtures/pi-preflight.js";

const mocks = vi.hoisted(() => ({ sdk: vi.fn(), rpc: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/pi/open.js", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), openPiAgentSession: mocks.sdk,
}));
vi.mock("../../packages/oar/src/runtimes/pi/rpc/open.js", () => ({ openPiRpc: mocks.rpc }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

async function fixture(mode: "SDK" | "RPC") {
  const native = piPreflightFixture();
  mocks.sdk.mockResolvedValue(native.sdk);
  mocks.rpc.mockImplementation(async (_options: unknown, _credentials: unknown, receive: Parameters<typeof native.rpc>[0]) => native.rpc(receive));
  const start = mode === "SDK" ? piSession : createPiRpcSession({ execution: "subprocess" });
  const session = await start({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  return { ...native, session, close: async () => { native.release(); await session.dispose(); } };
}
const id = "11111111-1111-4111-8111-111111111111";

test.each([["SDK", false], ["SDK", true], ["RPC", false], ["RPC", true]] as const)("%s custom messages followed by settlement (aborted=%s) do not invent a turn", async (mode, aborted) => {
  const f = await fixture(mode);
  try {
    const message = { role: "custom", customType: "notice", content: "hello", display: true, timestamp: 0 };
    f.emit({ type: "message_start", message });
    f.emit({ type: "message_end", message });
    f.settled(aborted); await settle();
    expect(f.session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_ended") : [])).toEqual([]);
    expect(f.session.status().value.kind).toBe("idle");
    expect(await f.session.prompt("NEXT")).toMatchObject({ kind: "accepted" });
  } finally { await f.close(); }
});

test("SDK dispatch avoids native settlement deferral so a refusal settles the correct input", async () => {
  const f = await fixture("SDK"); const b = f.hold("B");
  try {
    await f.session.prompt("A"); const queued = await f.session.queue("B", { inputId: id }); await f.session.queue("C");
    f.end(); await settle(); b.resolve("refused"); await settle();
    expect(f.prompts).toEqual(["A", "B", "C"]);
    expect(f.deferrals()).toBe(0);
    expect(turnEndAfter(f.session.records(), queued.seq, f.session.id, id)).toMatchObject({ kind: "failed", reason: "native preflight refused B" });
    expect(f.session.status().value.kind).toBe("running");
  } finally { b.resolve("refused"); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("%s preflight abort reaches an independently started extension run", async mode => {
  const f = await fixture(mode); const command = f.hold("/spawn");
  try {
    const pending = f.session.prompt("/spawn"); await settle();
    expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
    f.begin(); await settle();
    expect(mode === "SDK" ? f.aborts() : f.commandTypes.filter(type => type === "abort").length).toBe(1);
    if (mode === "RPC") { f.settled(true); await settle(); }
    command.resolve("handled"); await pending; await settle();
    expect(await f.session.prompt("NEXT")).toMatchObject({ kind: "accepted" });
    expect(mode === "SDK" ? f.aborts() : f.commandTypes.filter(type => type === "abort").length).toBe(1);
  } finally { command.resolve("handled"); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("%s started receipt followed by settlement without agent_start releases the input without completed", async mode => {
  const native = piPreflightFixture();
  let refuse = true;
  const original = native.sdk.prompt.bind(native.sdk);
  vi.spyOn(native.sdk, "prompt").mockImplementation(async (input, options) => {
    if (!refuse) { return original(input, options); }
    options?.preflightResult?.("started"); native.settled();
  });
  mocks.sdk.mockResolvedValue(native.sdk);
  mocks.rpc.mockImplementation(async (_options: unknown, _credentials: unknown, receive: Parameters<typeof native.rpc>[0]) => native.rpc(event => {
    if (refuse && event.type === "agent_start") { receive({ type: "agent_settled", aborted: false }); }
    else { receive(event); }
  }));
  const start = mode === "SDK" ? piSession : createPiRpcSession({ execution: "subprocess" });
  const session = await start({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  try {
    const result = await session.prompt("B", { inputId: id }); await settle();
    expect(session.status().value.kind).toBe("idle");
    expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_ended") : [])).toEqual([]);
    expect(turnEndAfter(session.records(), result.seq, session.id, id)).toMatchObject({ kind: "failed" });
    refuse = false;
    expect(await session.prompt("C")).toMatchObject({ kind: "accepted" });
  } finally { native.release(); await session.dispose(); }
});

test("SDK native refusal after its started receipt releases a reservation even without settlement", async () => {
  const native = piPreflightFixture();
  const original = native.sdk.prompt.bind(native.sdk);
  vi.spyOn(native.sdk, "prompt").mockImplementationOnce(async (_input, options) => {
    options?.preflightResult?.("started"); throw new Error("native run did not start");
  }).mockImplementation(original);
  mocks.sdk.mockResolvedValue(native.sdk);
  const session = await piSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  try {
    const result = await session.prompt("B", { inputId: id }); await settle();
    expect(result.kind).toBe("accepted");
    expect(session.status().value.kind).toBe("idle");
    expect(turnEndAfter(session.records(), result.request.seq, session.id, id)).toMatchObject({ kind: "failed", reason: "native run did not start" });
    expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_ended") : [])).toEqual([]);
    expect(await session.prompt("C")).toMatchObject({ kind: "accepted" });
  } finally { native.release(); await session.dispose(); }
});

test("RPC preflight abort starts its kill deadline only when a native run receives cancellation", async () => {
  const f = await fixture("RPC"); const command = f.hold("/spawn"); const kill = vi.spyOn(f.child, "kill");
  try {
    const pending = f.session.prompt("/spawn"); await settle(); vi.useFakeTimers();
    expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(kill).not.toHaveBeenCalled();
    expect(f.commandTypes).not.toContain("abort");
    f.begin(); await vi.advanceTimersByTimeAsync(0);
    expect(f.commandTypes.filter(type => type === "abort")).toHaveLength(1);
    f.settled(true); command.resolve("handled"); await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(kill).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); command.resolve("handled"); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("%s consumes a preflight abort once, before two extension runs finish the command", async mode => {
  const f = await fixture(mode); const command = f.hold("/spawn");
  try {
    const pending = f.session.prompt("/spawn"); await settle();
    expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
    f.begin(); await settle();
    if (mode === "RPC") { f.settled(true); await settle(); }
    // The same command is still awaiting its hook. Its consumed cancellation
    // must not cancel a second independent run before the handled receipt.
    f.begin(); await settle();
    expect(mode === "SDK" ? f.aborts() : f.commandTypes.filter(type => type === "abort").length).toBe(1);
    expect(f.session.status().value.kind).toBe("running");
    f.end(); await settle(); command.resolve("handled"); await pending;
  } finally { command.resolve("handled"); await f.close(); }
});

test("RPC preflight cancellation bounds a non-settling run from actual delivery", async () => {
  const f = await fixture("RPC"); const command = f.hold("/spawn"); const kill = vi.spyOn(f.child, "kill");
  try {
    const pending = f.session.prompt("/spawn"); await settle(); vi.useFakeTimers();
    expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(kill).not.toHaveBeenCalled();
    f.begin(); await vi.advanceTimersByTimeAsync(0);
    expect(f.commandTypes.filter(type => type === "abort")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledTimes(1);
    command.resolve("handled"); await pending;
  } finally { vi.useRealTimers(); command.resolve("handled"); await f.close(); }
});
