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
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped")))
      .toHaveLength(1);
    expect(JSON.stringify(f.session.records())).toContain("native preflight refused B");
    expect(await f.session.abort()).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
    expect(f.prompts).toEqual(["A", "B", "C"]);
  } finally { a.resolve("refused"); b.resolve("refused"); await f.close(); }
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

test("SDK dispatch outside settlement cannot accept an input before its own native preflight", async () => {
  const f = await fixture("SDK"); const b = f.hold("B");
  try {
    await f.session.prompt("A"); await f.session.queue("B"); await f.session.queue("C");
    f.end(); await settle();
    expect(f.deferrals()).toBe(0); expect(f.prompts).toEqual(["A", "B"]);
    const dispatch = f.session.records().find(record => record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined);
    expect(dispatch?.kind).toBe("request");
    expect(f.session.records().filter(record => record.kind === "response" && record.requestId === (dispatch?.kind === "request" ? dispatch.id : undefined)))
      .toEqual([]);
    expect(f.session.status().value.kind).toBe("running");
    b.resolve("handled"); await settle();
    expect(f.prompts).toEqual(["A", "B", "C"]);
  } finally { b.resolve("refused"); await f.close(); }
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

test("SDK disposal during preflight is reported as disposed even if native preflight later reports started", async () => {
  const f = await fixture("SDK"); const pending = f.hold("A");
  try {
    const result = f.session.prompt("A"); await settle();
    await f.session.dispose(); pending.resolve("start");
    expect(await result).toMatchObject({ kind: "rejected", code: "disposed" });
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toEqual([]);
  } finally { pending.resolve("refused"); await f.close(); }
});

// Pi's native settlement emitter can defer prompt() without a per-input admission result.
test.each(["SDK", "RPC"] as const)("Pi %s keeps synchronous terminal submission busy until the observer returns", async mode => {
  const f = await fixture(mode); const observed: { status: string; result: Promise<ControlResult> }[] = [];
  try {
    await f.session.prompt("A");
    onEnd(f.session, () => { observed.push({ status: f.session.status().value.kind, result: f.session.prompt("B") }); });
    f.end(); await settle();
    expect(observed[0]?.status).toBe("idle");
    expect(await observed[0]?.result).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.prompts).toEqual(["A"]); expect(f.deferrals()).toBe(0);
    expect(await f.session.prompt("B")).toMatchObject({ kind: "accepted" });
    expect(f.prompts).toEqual(["A", "B"]); expect(f.session.status().value.kind).toBe("running");
  } finally { await f.close(); }
});

test.each([
  ["SDK", "prompt"], ["SDK", "queue"], ["RPC", "prompt"], ["RPC", "queue"],
] as const)("Pi %s preserves held FIFO against terminal observer %s without releasing early", async (mode, control) => {
  const f = await fixture(mode); const results: Promise<ControlResult>[] = [];
  try {
    await f.session.prompt("A"); await f.session.queue("B");
    onEnd(f.session, () => { results.push(f.session[control]("C")); });
    f.end(); await settle();
    expect(await results[0]).toMatchObject(control === "prompt" ? { kind: "rejected", code: "busy" } : { kind: "accepted" });
    expect(f.prompts).toEqual(["A", "B"]);
    f.end(); await settle();
    expect(f.prompts).toEqual(control === "queue" ? ["A", "B", "C"] : ["A", "B"]);
  } finally { await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s keeps terminal observer compaction behind held input", async mode => {
  const f = await fixture(mode); const results: unknown[] = [];
  try {
    await f.session.prompt("A"); await f.session.queue("B");
    onEnd(f.session, () => { results.push(f.session.compact?.()); });
    f.end(); await settle();
    expect(await results[0]).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.prompts).toEqual(["A", "B"]);
  } finally { await f.close(); }
});

test("SDK disposal preserves a later native preflight refusal without inventing a turn end", async () => {
  const f = await fixture("SDK"); const b = f.hold("B");
  try {
    await f.session.prompt("A"); await f.session.queue("B"); f.end(); await settle();
    expect(f.prompts).toEqual(["A", "B"]);
    await f.session.dispose();
    const releasedAt = f.session.records().at(-1)?.seq ?? -1;
    b.resolve("refused"); await settle();
    const late = f.session.records().filter(record => record.seq > releasedAt && record.kind === "frame");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ body: { type: "pi/prompt_rejected", native: { message: "native preflight refused B" },
      events: [{ kind: "input_dropped", reason: "runtime_refused", message: "native preflight refused B" }] } });
    expect(f.session.status().value.kind).toBe("idle");
    expect(late.flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_ended") : [])).toEqual([]);
  } finally { b.resolve("refused"); await f.close(); }
});

test("RPC clears cancellation fallback rearmed by a synchronous terminal observer", async () => {
  const f = await fixture("RPC"); const kill = vi.spyOn(f.child, "kill"); const aborted: Promise<ControlResult>[] = [];
  try {
    await f.session.prompt("A"); vi.useFakeTimers();
    onEnd(f.session, () => { aborted.push(f.session.abort()); }); f.end();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await aborted[0]).toMatchObject({ kind: "accepted" }); expect(kill).not.toHaveBeenCalled();
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
  } finally { vi.useRealTimers(); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s records a pre-start refusal before the next queued native start", async mode => {
  const f = await fixture(mode); const a = f.hold("A");
  try {
    const first = f.session.prompt("A"); await settle(); await f.session.queue("B");
    a.resolve("refused"); const refused = await first; await settle();
    const start = f.session.records().find(record => record.kind === "frame" && record.body.type === "agent_start");
    expect(start?.seq).toBeGreaterThan(refused.response.seq);
    expect(f.session.status().value.kind).toBe("running");
    expect(await f.session.prompt("C")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { a.resolve("refused"); await f.close(); }
});

test("SDK native rejection after start clears cancellation before the next run", async () => {
  const f = await fixture("SDK");
  try {
    await f.session.prompt("A"); f.sdk.isStreaming = false;
    await f.session.abort(); f.runs[0]?.reject(new Error("native prompt failed before settlement")); await settle();
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toHaveLength(1);
    expect(await f.session.prompt("C")).toMatchObject({ kind: "accepted" });
    expect(f.aborts()).toBe(0); expect(f.session.status().value.kind).toBe("running");
  } finally { await f.close(); }
});

test.each([
  ["SDK", "prompt"], ["SDK", "queue"], ["SDK", "compact"],
  ["RPC", "prompt"], ["RPC", "queue"], ["RPC", "compact"],
] as const)("Pi %s keeps held FIFO when a preflight-refusal observer calls %s", async (mode, control) => {
  const f = await fixture(mode); const a = f.hold("A"); const results: Promise<unknown>[] = [];
  try {
    const first = f.session.prompt("A"); await settle(); await f.session.queue("B");
    let used = false;
    f.session.rawEvents(record => {
      if (used || record.kind !== "response" || record.body.kind !== "rejected") { return; }
      used = true;
      const result = control === "compact" ? f.session.compact?.() : f.session[control]("C");
      if (result === undefined) { throw new Error("expected compact"); } results.push(result);
    });
    a.resolve("refused"); await first; await settle();
    expect(await results[0]).toMatchObject(control === "queue" ? { kind: "accepted" } : { kind: "rejected", code: "busy" });
    expect(f.prompts).toEqual(["A", "B"]);
    f.end(); await settle();
    expect(f.prompts).toEqual(control === "queue" ? ["A", "B", "C"] : ["A", "B"]);
  } finally { a.resolve("refused"); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s handling releases its request before observers, without bypassing held inputs", async mode => {
  const f = await fixture(mode); const a = f.hold("A"); const results: Promise<ControlResult>[] = [];
  try {
    const first = f.session.prompt("A"); await settle(); await f.session.queue("B");
    f.session.rawEvents(record => {
      if (record.kind === "frame" && record.body.events.some(event => event.kind === "input_handled")) { results.push(f.session.prompt("C")); }
    });
    a.resolve("handled"); await first; await settle();
    expect(await results[0]).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.prompts).toEqual(["A", "B"]);
  } finally { a.resolve("refused"); await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s cannot dispatch a queued input before publishing its acceptance", async mode => {
  const f = await fixture(mode);
  try {
    await f.session.prompt("A");
    const atAcceptance: string[][] = [];
    f.session.rawEvents(record => {
      if (record.kind === "response" && record.body.kind === "accepted" && record.body.queued === "adapter") { atAcceptance.push([...f.prompts]); }
    });
    const queued = f.session.queue("B"); f.end(); await queued; await settle();
    expect(atAcceptance).toEqual([["A"]]); expect(f.prompts).toEqual(["A", "B"]);
    const request = f.session.records().find(record => record.kind === "request" && record.body.kind === "queue");
    const accepted = f.session.records().find(record => record.kind === "response" && record.requestId === (request?.kind === "request" ? request.id : undefined));
    const dispatch = f.session.records().find(record => record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined);
    expect(dispatch?.seq).toBeGreaterThan(accepted?.seq ?? Infinity);
  } finally { await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s terminal-observer queue records acceptance before dispatch", async mode => {
  const f = await fixture(mode); const queued: Promise<ControlResult>[] = []; const seen: string[][] = [];
  try {
    await f.session.prompt("A");
    f.session.rawEvents(record => {
      if (record.kind === "response" && record.body.kind === "accepted" && record.body.queued === "adapter") { seen.push([...f.prompts]); }
    });
    onEnd(f.session, () => { queued.push(f.session.queue("B")); });
    f.end(); await settle(); await Promise.all(queued);
    expect(seen).toEqual([["A"]]); expect(f.prompts).toEqual(["A", "B"]);
    const accepted = f.session.records().find(record => record.kind === "response" && record.body.kind === "accepted" && record.body.queued === "adapter");
    const dispatch = f.session.records().find(record => record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined);
    expect(dispatch?.seq).toBeGreaterThan(accepted?.seq ?? Infinity);
  } finally { await f.close(); }
});

test.each(["SDK", "RPC"] as const)("Pi %s handling forgets cancellation for that admission before the next queued run", async mode => {
  const f = await fixture(mode); const a = f.hold("A");
  try {
    const first = f.session.prompt("A"); await settle();
    expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
    await f.session.queue("B"); a.resolve("handled"); await first; await settle();
    expect(f.prompts).toEqual(["A", "B"]); expect(f.aborts()).toBe(0);
    expect(f.session.status().value.kind).toBe("running");
  } finally { a.resolve("refused"); await f.close(); }
});
