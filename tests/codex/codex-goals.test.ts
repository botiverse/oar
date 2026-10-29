import { afterEach, expect, test, vi } from "vitest";
import type { Event, RawEvent } from "../../packages/oar/src/contracts/session.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { eventsReader } from "../../packages/oar/src/observe/events.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(...args: unknown[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex", version: "0.165.0" } as const;
const goal = { threadId: "root", objective: "Native objective", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 123, updatedAt: 123 };
afterEach(() => { spawnLineProcess.mockReset(); });

function server(options: { disabled?: boolean; resumed?: boolean; hold?: boolean; refusal?: boolean; malformed?: boolean } = {}): FakeLineProcess {
  // oxlint-disable-next-line eslint/max-statements -- Script each native control response and its following notification in wire order.
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number") { return; }
    const { id } = message;
    const reply = (result: unknown): void => { process.emit(`${JSON.stringify({ id, result })}\n`); };
    switch (message.method) {
      case "config/read": reply({ config: { features: { goals: options.disabled !== true } } }); break;
      case "thread/start":
      case "thread/resume":
        reply({ thread: { id: "root" }, model: "gpt-5.1" });
        if (options.resumed === true) { notify(process, "thread/goal/updated", { threadId: "root", goal }); }
        break;
      case "thread/goal/set":
      case "thread/goal/get":
      case "thread/goal/clear": {
        if (options.hold === true) { break; }
        if (options.refusal === true) {
          process.emit(`${JSON.stringify({ id, error: { code: -32_600, message: "native refusal", data: { detail: "retained" } } })}\n`);
          break;
        }
        const result = message.method === "thread/goal/clear" ? { cleared: false } : { goal };
        reply(options.malformed === true ? {} : result);
        if (message.method === "thread/goal/set" && options.malformed !== true) { notify(process, "thread/goal/updated", { threadId: "root", goal }); }
        break;
      }
      default: reply({});
    }
  });
  spawnLineProcess.mockReturnValue(fake); return fake;
}
function notify(fake: FakeLineProcess, method: string, params: unknown): void {
  fake.emit(`${JSON.stringify({ method, params })}\n`);
}
function sent(fake: FakeLineProcess): string[] {
  return fake.written.flatMap((line) => {
    const item = asRecord(JSON.parse(line)); return typeof item?.method === "string" ? [item.method] : [];
  });
}

// oxlint-disable-next-line eslint/max-statements -- Verify the full control and replay boundary together.
test("goals opt-in records native answers in wire order and replays the same events", async () => {
  const fake = server();
  const session = await codexSession(installation, { cwd: "/work", goals: true });
  expect(session.goal).toBeDefined();
  expect(spawnLineProcess.mock.calls[0]?.[1]).toContain("features.goals=true");
  const live: Event[] = []; session.events((event) => { live.push(event); }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  const set = await session.goal?.set({ objective: "Requested objective", status: "paused", tokenBudget: 500 });
  expect(set).toMatchObject({ kind: "accepted", request: { body: { kind: "goal_set" } } });
  const observed = live.filter((event) => event.kind === "goal_changed");
  expect(observed).toHaveLength(2);
  expect(observed[0]).toMatchObject({ goal: { objective: "Native objective", status: "paused", tokensUsed: 0, tokenBudget: null }, seq: (set?.request.seq ?? 0) + 1 });
  expect(observed[1]?.seq).toBeGreaterThan(observed[0]?.seq ?? -1);
  expect(set?.response.seq).toBeGreaterThan(observed[0]?.seq ?? -1);
  expect(set?.response.seq).toBeLessThan(observed[1]?.seq ?? 0);
  expect(set?.response.body).toEqual({ kind: "accepted" });
  expect(session.records().find((record) => record.seq === observed[0]?.seq)).toMatchObject({ kind: "frame", body: { type: "thread/goal/set", native: { goal } } });
  expect(session.status().value.kind).toBe("idle");
  const read = await session.goal?.read();
  expect(read).toMatchObject({ kind: "accepted", request: { body: { kind: "goal_read" } } });
  const clear = await session.goal?.clear();
  expect(clear).toMatchObject({ kind: "accepted", request: { body: { kind: "goal_clear" } } });
  expect(live.at(-1)).toMatchObject({ kind: "goal_changed", goal: null });
  expect(sent(fake)).toContain("thread/goal/get");
  const replay: Event[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- Exercise the serialized stream hosts persist.
  const saved: RawEvent[] = JSON.parse(JSON.stringify(session.records()));
  const reader = eventsReader((event) => { replay.push(event); });
  saved.forEach((record) => { reader(record); });
  expect(replay).toEqual(live);
  await session.dispose();
});

test.each([undefined, false])("goals=%s adds no override, reader call or member", async (enabled) => {
  const fake = server();
  const session = await codexSession(installation, { cwd: "/work", ...(enabled === undefined ? {} : { goals: enabled }) });
  expect("goal" in session).toBe(false);
  expect(spawnLineProcess.mock.calls[0]?.[1]).not.toContain("features.goals=true");
  expect(sent(fake)).not.toContain("config/read");
  await session.dispose();
});

test("conflicting launch settings cannot silently disable an explicit goals request", async () => {
  const fake = server({ disabled: true });
  await expect(codexSession(installation, { cwd: "/work", goals: true, launchArgs: ["-c", "features.goals=false"] })).rejects.toThrow("did not confirm goals enabled");
  expect(fake.killed()).toBe(true);
  expect(sent(fake)).not.toContain("thread/start");
});

// oxlint-disable-next-line eslint/max-statements -- Keep setup, native evidence and its absence/attribution assertions together.
test("resume and child goal snapshots keep attribution and unfamiliar statuses without filling absent fields", async () => {
  const fake = server({ resumed: true });
  const session = await codexSession(installation, { cwd: "/work", goals: true, resume: "root" });
  const events: Event[] = []; session.events((event) => { events.push(event); }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  expect(events.some((event) => event.kind === "goal_changed" && event.goal?.objective === goal.objective)).toBe(true);
  notify(fake, "thread/goal/updated", { threadId: "child", goal: { objective: "Child", status: "futureNativeStatus" } });
  expect(events.at(-1)).toMatchObject({ sessionId: "child", kind: "goal_changed", goal: { objective: "Child", status: "futureNativeStatus" } });
  const last = events.at(-1); expect(last?.kind === "goal_changed" ? Object.keys(last.goal ?? {}) : []).toEqual(["objective", "status"]);
  const count = events.filter((event) => event.kind === "goal_changed").length;
  notify(fake, "turn/completed", { threadId: "root", turn: { id: "t", status: "completed" } });
  expect(events.filter((event) => event.kind === "goal_changed")).toHaveLength(count);
  notify(fake, "thread/goal/cleared", { threadId: "root" });
  expect(events.at(-1)).toMatchObject({ kind: "goal_changed", goal: null, sessionId: "root" });
  await session.dispose();
});

test("unsupported goal values are recorded refusals before sending", async () => {
  const fake = server();
  const session = await codexSession(installation, { cwd: "/work", goals: true });
  const previous = fake.written.length;
  expect(await session.goal?.set({ objective: "x", status: "unknown" })).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(await session.goal?.set({ objective: "x", tokenBudget: -1 })).toMatchObject({ kind: "rejected", code: "unsupported" });
  const extraOption = { objective: "x", unsupportedField: true };
  expect(await session.goal?.set(extraOption)).toMatchObject({ kind: "rejected", code: "unsupported" });
  expect(fake.written).toHaveLength(previous);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Keep setup, native evidence and its absence/attribution assertions together.
test.each(["refusal", "malformed"] as const)("a %s answer never fabricates goal state", async (mode) => {
  server({ [mode]: true });
  const session = await codexSession(installation, { cwd: "/work", goals: true });
  const events: Event[] = []; session.events((event) => { events.push(event); });
  const result = await session.goal?.set({ objective: "requested", status: "active" });
  expect(result).toMatchObject({ kind: "rejected", code: "runtime_refused" });
  if (mode === "refusal") { expect(result?.response.body).toMatchObject({ native: { code: -32_600, data: { detail: "retained" } } }); }
  expect(events.some((event) => event.kind === "goal_changed")).toBe(false);
  expect(events.at(-1)).toMatchObject({ kind: "control_rejected", action: "goal_set" });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Keep setup, native evidence and its absence/attribution assertions together.
test("pending goal updates are not optimistic, exit settles them once, and disposed controls never send", async () => {
  const fake = server({ hold: true });
  const session = await codexSession(installation, { cwd: "/work", goals: true });
  const events: Event[] = []; session.events((event) => { events.push(event); });
  const pending = session.goal?.set({ objective: "pending" });
  expect(events).toEqual([]);
  expect(session.status().value.kind).toBe("idle");
  fake.end(2);
  const result = await pending;
  expect(result).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  expect(session.records().filter((record) => record.kind === "response" && record.requestId === result?.request.id)).toHaveLength(1);
  await session.dispose();
  const previous = fake.written.length;
  expect(await session.goal?.clear()).toMatchObject({ kind: "rejected" });
  expect(fake.written).toHaveLength(previous);
  expect(events.some((event) => event.kind === "goal_changed")).toBe(false);
});

// oxlint-disable-next-line eslint/max-statements -- Keep setup, native evidence and its absence/attribution assertions together.
test("goal payloads and native refusal diagnostics use the session credential redactor", async () => {
  const fake = server({ hold: true });
  const secret = "secret-goal-value-123456";
  const session = await codexSession(installation, { cwd: "/work", goals: true, env: { TEST_API_KEY: secret } });
  const pending = session.goal?.set({ objective: secret });
  const last = asRecord(JSON.parse(fake.written.at(-1) ?? "{}"));
  expect(asRecord(last?.params)?.objective).toBe(secret);
  fake.emit(`${JSON.stringify({ id: last?.id, error: { code: -32_600, message: secret, data: { detail: secret } } })}\n`);
  const result = await pending;
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(session.records())).not.toContain(secret);
  await session.dispose();
});
