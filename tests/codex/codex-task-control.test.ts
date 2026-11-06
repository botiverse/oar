/* oxlint-disable eslint/max-statements -- Assert the complete control and replay sequence together. */
import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(...args: unknown[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { vi.clearAllMocks(); });
const installation = { kind: "available", via: "executable", command: "codex", version: "0.167.0" } as const;
function notify(fake: FakeLineProcess, method: string, params: unknown): void { fake.emit(`${JSON.stringify({ method, params })}\n`); }
function child(fake: FakeLineProcess, id: string, parent = "root"): void {
  notify(fake, "item/completed", { threadId: parent, turnId: "parent-turn", item: { type: "subAgentActivity", kind: "started", id: `spawn-${id}`, agentThreadId: id, agentPath: `/root/${id}` } });
  notify(fake, "turn/started", { threadId: id, turn: { id: `turn-${id}` } });
}
function server(refused = false): FakeLineProcess {
  const fake = fakeLineProcess((line, process) => {
    const request = asRecord(parseJson(line)); if (typeof request?.id !== "number") { return; }
    if (refused && request.method === "turn/interrupt") {
      process.emit(`${JSON.stringify({ id: request.id, error: { code: -32_600, message: "native refusal" } })}\n`); return;
    }
    process.emit(`${JSON.stringify({ id: request.id, result: request.method === "thread/start" ? { thread: { id: "root" }, model: "gpt-5.1" } : {} })}\n`);
  }); spawnLineProcess.mockReturnValue(fake); return fake;
}
function interrupts(fake: FakeLineProcess) { return fake.written.map(line => asRecord(parseJson(line))).filter(r => r?.method === "turn/interrupt"); }

test("stopTask interrupts only the named child's active turn, without inventing task completion", async () => {
  const fake = server(); const session = await codexSession(installation, { cwd: "/work" });
  try {
    child(fake, "A"); child(fake, "B");
    expect(await session.stopTask?.("A")).toMatchObject({ kind: "accepted", request: { body: { kind: "stop_task", taskId: "A" } } });
    expect(interrupts(fake).map(r => r?.params)).toEqual([{ threadId: "A", turnId: "turn-A" }]);
    notify(fake, "turn/completed", { threadId: "A", turn: { id: "turn-A", status: "interrupted" } });
    expect(session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "task_ended") : [])).toEqual([]);
    expect(await session.stopTask?.("A")).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    notify(fake, "turn/started", { threadId: "A", turn: { id: "resumed-A" } });
    // A late completion for the interrupted turn cannot hide the new turn.
    notify(fake, "turn/completed", { threadId: "A", turn: { id: "turn-A", status: "interrupted" } });
    expect(await session.stopTask?.("A")).toMatchObject({ kind: "accepted" });
    expect(interrupts(fake).at(-1)?.params).toEqual({ threadId: "A", turnId: "resumed-A" });
    expect(await session.stopTask?.("B")).toMatchObject({ kind: "accepted" });
    expect(interrupts(fake).at(-1)?.params).toEqual({ threadId: "B", turnId: "turn-B" });
    expect(fake.killed()).toBe(false);
  } finally { await session.dispose(); }
});

test("root and unowned sessions are refused even with native turn notifications; descendants are allowed", async () => {
  const fake = server(); const session = await codexSession(installation, { cwd: "/work" });
  try {
    notify(fake, "turn/started", { threadId: "foreign", turn: { id: "foreign-turn" } });
    await Promise.all(["root", "foreign", "missing", ""].map(async id => { expect(await session.stopTask?.(id)).toMatchObject({ kind: "rejected", code: "unsupported" }); }));
    expect(interrupts(fake)).toEqual([]);
    child(fake, "A"); child(fake, "grandchild", "A");
    expect(await session.stopTask?.("grandchild")).toMatchObject({ kind: "accepted" });
    expect(interrupts(fake).map(r => r?.params)).toEqual([{ threadId: "grandchild", turnId: "turn-grandchild" }]);
  } finally { await session.dispose(); }
});

test("native refusal is recorded, and a synchronous request observer can close before send", async () => {
  const fake = server(true); const session = await codexSession(installation, { cwd: "/work" });
  child(fake, "A");
  expect(await session.stopTask?.("A")).toMatchObject({ kind: "rejected", code: "runtime_refused", response: { body: { native: { code: -32_600 } } } });
  const count = interrupts(fake).length;
  session.rawEvents(record => { if (record.kind === "request" && record.body.kind === "stop_task") { fake.end(0); } });
  expect(await session.stopTask?.("A")).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  expect(interrupts(fake)).toHaveLength(count); await session.dispose();
});
