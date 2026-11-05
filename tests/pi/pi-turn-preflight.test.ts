/* oxlint-disable max-statements -- Keep native scheduling and reentrant controls in one ordered regression. */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { ControlResult, Session } from "../../packages/oar/src/contracts/session.js";
import { piSession } from "../../packages/oar/src/runtimes/pi/session.js";
import { createPiRpcSession } from "../../packages/oar/src/runtimes/pi/rpc/session.js";
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

function onEnd(session: Session, action: () => void): void {
  let used = false;
  session.rawEvents(record => {
    if (used || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
    used = true; action();
  });
}

test.each(["SDK", "RPC"] as const)("Pi %s drains held work after preflight refusal, including its own refusal", async mode => {
  const f = await fixture(mode); const a = f.hold("A"); const b = f.hold("B");
  try {
    const first = f.session.prompt("A"); await settle();
    await f.session.queue("B"); a.resolve("refused");
    expect(await first).toMatchObject({ kind: "rejected", code: "runtime_refused" }); await settle();
    expect(f.prompts).toEqual(["A", "B"]); b.resolve("refused"); await settle();
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected"))
      .toHaveLength(1);
    expect(JSON.stringify(f.session.records())).toContain("native preflight refused B");
    expect(await f.session.abort()).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
    expect(f.prompts).toEqual(["A", "B", "C"]);
  } finally { a.resolve("refused"); b.resolve("refused"); await f.close(); }
});

test("SDK terminal reentry waits for native admission instead of accepting a deferred prompt", async () => {
  const f = await fixture("SDK"); const b = f.hold("B"); const observed: Promise<ControlResult>[] = [];
  try {
    await f.session.prompt("A"); onEnd(f.session, () => { observed.push(f.session.prompt("B")); });
    f.end(); await settle();
    let answered = false; void (async () => { await observed[0]; answered = true; })(); await settle();
    expect(answered).toBe(false); expect(f.deferrals()).toBe(0);
    b.resolve("refused"); expect(await observed[0]).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
    expect(f.prompts).toEqual(["A", "B", "C"]);
  } finally { b.resolve("refused"); await f.close(); }
});

test("SDK preflight refusal clears its pending abort before the next run", async () => {
  const f = await fixture("SDK"); const a = f.hold("A");
  try {
    const first = f.session.prompt("A"); await settle();
    expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
    a.resolve("refused"); expect(await first).toMatchObject({ kind: "rejected" });
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
    expect(f.aborts()).toBe(0); expect(f.session.status().value.kind).toBe("running");
  } finally { a.resolve("refused"); await f.close(); }
});

test("SDK settlement clears an abort held during asynchronous native settlement", async () => {
  const f = await fixture("SDK");
  try {
    await f.session.prompt("A"); f.sdk.isStreaming = false;
    f.emit({ type: "agent_end", messages: [] });
    await f.session.abort(); f.settled(); await settle();
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
    expect(f.aborts()).toBe(0); expect(f.session.status().value.kind).toBe("running");
  } finally { await f.close(); }
});

test("SDK settlement forgets the old launch before an extension starts an independent run", async () => {
  const f = await fixture("SDK");
  try {
    await f.session.prompt("A"); f.end(); await settle(); f.begin();
    f.runs[0]?.reject(new Error("late old failure")); await settle();
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toEqual([]);
    expect(f.session.status().value.kind).toBe("running");
    expect(await f.session.prompt("cannot replace extension run")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await f.close(); }
});

test("RPC keeps queued dispatch after the observable terminal frame", async () => {
  const f = await fixture("RPC"); const seen: string[][] = [];
  try {
    await f.session.prompt("A"); await f.session.queue("B");
    onEnd(f.session, () => { seen.push([...f.prompts]); }); f.end(); await settle();
    expect(seen).toEqual([["A"]]); expect(f.prompts).toEqual(["A", "B"]);
  } finally { await f.close(); }
});

test("RPC state replies after extension dispatch preserve the current model and effort", async () => {
  const f = await fixture("RPC");
  try {
    f.emit({ type: "response", command: "get_state", success: true, data: { model: { provider: "extension", id: "changed" }, thinkingLevel: "high" } });
    await settle();
    const frames = f.session.records().flatMap(record => record.kind === "frame" && record.body.type === "response" ? [record.body] : []);
    expect(frames.at(-1)?.events).toEqual([{ kind: "model", model: "extension/changed" }, { kind: "effort", effort: "high" }]);
  } finally { await f.close(); }
});

test("RPC clears cancellation fallback rearmed while terminal stats are pending", async () => {
  const f = await fixture("RPC"); const stats = f.holdStats(); const kill = vi.spyOn(f.child, "kill");
  try {
    await f.session.prompt("A"); f.end(); await stats.entered;
    vi.useFakeTimers(); await f.session.abort();
    stats.reply.resolve({ type: "response", command: "get_session_stats", success: false, error: "no stats" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(kill).not.toHaveBeenCalled(); expect(f.session.status().value.kind).toBe("idle");
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
  } finally { vi.useRealTimers(); await f.close(); }
});

test("SDK extension-handled input releases its reservation and drains held work without a fake turn", async () => {
  const f = await fixture("SDK"); const a = f.hold("A");
  try {
    const first = f.session.prompt("A"); await settle(); await f.session.queue("B");
    a.resolve("handled"); expect(await first).toMatchObject({ kind: "accepted" }); await settle();
    expect(f.prompts).toEqual(["A", "B"]);
    expect(f.session.records().filter(record => record.kind === "frame").map(record => record.body.type)).toEqual(["agent_start"]);
  } finally { a.resolve("handled"); await f.close(); }
});

test("SDK dispose in the terminal observer prevents its newly reserved prompt from reaching Pi", async () => {
  const f = await fixture("SDK"); const observed: Promise<ControlResult>[] = []; const disposed: Promise<void>[] = [];
  try {
    await f.session.prompt("A");
    onEnd(f.session, () => { observed.push(f.session.prompt("B")); disposed.push(f.session.dispose()); });
    f.end(); await settle(); await Promise.all(disposed);
    expect(await observed[0]).toMatchObject({ kind: "rejected", code: "disposed" }); expect(f.prompts).toEqual(["A"]);
  } finally { await f.close(); }
});

test("SDK does not accept a pending input when an unrelated extension run starts", async () => {
  const f = await fixture("SDK"); const pending = f.hold("B");
  try {
    let answered = false;
    const result = (async (): Promise<ControlResult> => { const value = await f.session.prompt("B"); answered = true; return value; })();
    await settle(); f.begin(); await settle();
    expect(answered).toBe(false);
    pending.resolve("refused");
    expect(await result).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    expect(await f.session.prompt("cannot replace extension")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "turn_ended"))).toBe(false);
  } finally { pending.resolve("refused"); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s returns a held input to the front when an extension wins admission", async mode => {
  const f = await fixture(mode); const pending = f.hold("B");
  try {
    await f.session.prompt("A"); await f.session.queue("B"); await f.session.queue("C");
    f.end(); await settle(); f.begin(); pending.resolve("refused"); await settle();
    expect(f.prompts).toEqual(["A", "B"]);
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toEqual([]);
    f.hold("B").resolve("start"); f.end(); await settle();
    expect(f.prompts).toEqual(["A", "B", "B"]);
    f.end(); await settle(); expect(f.prompts).toEqual(["A", "B", "B", "C"]);
  } finally { pending.resolve("refused"); await f.close(); }
});

test("SDK disposal during preflight is reported as disposed even if native preflight later reports started", async () => {
  const f = await fixture("SDK"); const pending = f.hold("A");
  try {
    const result = f.session.prompt("A"); await settle();
    await f.session.dispose(); pending.resolve("start");
    expect(await result).toMatchObject({ kind: "rejected", code: "disposed" });
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toEqual([]);
  } finally { pending.resolve("refused"); await f.close(); }
});
