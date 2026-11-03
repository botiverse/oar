/* oxlint-disable eslint/max-statements -- Keep each ordered native control and its negative assertions together. */
import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.316" } as const;
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

async function open(builtin = true, answer = true) {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (answer && asRecord(message?.request)?.subtype === "initialize") {
      process.emit(line({ type: "control_response", response: { subtype: "success", request_id: message?.request_id,
        response: { account: { email: "private@example.test" }, commands: [{ name: "compact", ...(builtin ? { builtin: true } : {}) }] } } }));
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  assert.ok(session.compact !== undefined);
  return { session, compact: session.compact.bind(session), fake,
    dispatch: async () => {
      await vi.waitFor(() => { expect(fake.written.some((text) => asRecord(JSON.parse(text))?.type === "user")).toBe(true); });
      const message = fake.written.map((text) => asRecord(JSON.parse(text))).find((value) => value?.type === "user");
      assert.ok(typeof message?.uuid === "string");
      const id = message.uuid;
      fake.emit(line({ type: "command_lifecycle", command_uuid: id, state: "started" }));
      return id;
    },
  };
}
const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } };
const end = (id: string, extra = {}) => ({ type: "result", subtype: "success", is_error: false, user_message_uuid: id, ...extra });

test("the same-process source read is private and acceptance/boundary do not finish the command early", async () => {
  const f = await open();
  try {
    const waiting = f.compact();
    const id = await f.dispatch();
    f.fake.emit(line(boundary));
    expect(f.session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
    f.fake.emit(line(end("foreign-command")));
    expect(f.session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
    f.fake.emit(line(end(id)));
    const result = await waiting;
    expect(result).toMatchObject({ kind: "completed", frame: { body: { type: "system/compact_boundary" } } });
    expect(f.session.status().value.kind).toBe("idle");
    expect(JSON.stringify(f.session.records())).not.toContain("private@example.test");
    expect(f.session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(0);
  } finally { await f.session.dispose(); }
});

test("shadowed or unverified commands are rejected before a slash command is sent", async () => {
  const f = await open(false);
  try {
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "unsupported" });
    expect(f.fake.written).toHaveLength(1);
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});

test.each(["no boundary", "changed source", "native failure"] as const)("%s cannot report a completed compaction", async (mode) => {
  const f = await open();
  try {
    const waiting = f.compact();
    const id = await f.dispatch();
    if (mode === "changed source") { f.fake.emit(line({ type: "system", subtype: "commands_changed" })); f.fake.emit(line(boundary)); }
    // A child's boundary is never evidence for this root request.
    f.fake.emit(line({ ...boundary, parent_tool_use_id: "child" }));
    f.fake.emit(line(end(id, mode === "native failure" ? { is_error: true, subtype: "error_during_execution", errors: ["native failure"] } : {})));
    expect(await waiting).toMatchObject({ kind: "failed", code: ({ "changed source": "command_changed", "native failure": "native_failed", "no boundary": "not_compacted" }[mode]) });
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});

test("waiting timeout retains the input gate; queued inputs are delivered after native completion", async () => {
  const f = await open();
  try {
    const waiting = f.compact({ timeoutMs: 1 });
    const id = await f.dispatch();
    expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "timeout" });
    expect(f.session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
    expect(await f.session.prompt("refused")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(await f.session.queue("kept")).toMatchObject({ kind: "accepted" });
    expect(f.fake.written.filter((text) => text.includes('"type":"user"'))).toHaveLength(1);
    f.fake.emit(line(boundary)); f.fake.emit(line(end(id)));
    await vi.waitFor(() => { expect(f.fake.written.some((text) => text.includes("kept"))).toBe(true); });
  } finally { await f.session.dispose(); }
});

test("dispose during provenance lookup cannot later dispatch compact", async () => {
  const f = await open(true, false);
  const waiting = f.compact();
  await f.session.dispose();
  expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "disposed" });
  await Promise.resolve();
  expect(f.fake.written).toHaveLength(1);
  const disposeSeq = f.session.records().find((record) => record.kind === "request" && record.body.kind === "dispose")?.seq ?? -1;
  expect(f.session.records().filter((record) => record.seq > disposeSeq && record.kind === "response" && record.body.kind === "rejected")).toEqual([]);
});

test("native compaction failure wins over a successful ordinary command result", async () => {
  const f = await open();
  try {
    const waiting = f.compact();
    const id = await f.dispatch();
    f.fake.emit(line({ type: "system", subtype: "status", compact_result: "failed", compact_error: "native failure" }));
    f.fake.emit(line(end(id)));
    expect(await waiting).toMatchObject({ kind: "failed", code: "native_failed", frame: { body: { native: { compact_result: "failed" } } } });
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});

test("a catalog containing both builtin and user compact entries is refused", async () => {
  const f = await open(true, false);
  try {
    const waiting = f.compact();
    const query = asRecord(JSON.parse(f.fake.written[0] ?? "{}"));
    f.fake.emit(line({ type: "control_response", response: { subtype: "success", request_id: query?.request_id, response: { commands: [{ name: "compact", builtin: true }, { name: "compact" }] } } }));
    expect(await waiting).toMatchObject({ kind: "rejected", code: "unsupported" });
    expect(f.fake.written).toHaveLength(1);
  } finally { await f.session.dispose(); }
});

test("source query timeout has its own reason and a late source reply cannot dispatch", async () => {
  vi.useFakeTimers();
  const f = await open(true, false);
  try {
    const waiting = f.compact();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await waiting).toMatchObject({ kind: "rejected", code: "runtime_refused", reason: "Claude command provenance query timeout" });
    const query = asRecord(JSON.parse(f.fake.written[0] ?? "{}"));
    f.fake.emit(line({ type: "control_response", response: { subtype: "success", request_id: query?.request_id, response: { commands: [{ name: "compact", builtin: true }] } } }));
    expect(f.fake.written).toHaveLength(1);
  } finally { await f.session.dispose(); }
});

test("abort cancels the native queued compact command and never fires its process fallback", async () => {
  const f = await open();
  try {
    const seed = await f.session.prompt("seed");
    assert.ok(seed.request.body.kind === "prompt" && seed.request.body.inputId !== undefined);
    f.fake.emit(line({ type: "system", subtype: "init", session_id: f.session.id, capabilities: ["interrupt_cancel_queued_v1"] }));
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: seed.request.body.inputId, state: "started" }));
    f.fake.emit(line(end(seed.request.body.inputId)));
    vi.useFakeTimers();
    const before = f.fake.written.length;
    const waiting = f.compact();
    await vi.waitFor(() => { expect(f.fake.written).toHaveLength(before + 2); });
    const command = asRecord(JSON.parse(f.fake.written[before + 1] ?? "{}"));
    assert.ok(typeof command?.uuid === "string");
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: command.uuid, state: "queued" }));
    const aborted = f.session.abort();
    await vi.waitFor(() => { expect(f.fake.written.some((text) => text.includes('"subtype":"interrupt"'))).toBe(true); });
    const interrupt = f.fake.written.map((text) => asRecord(JSON.parse(text))).find((message) => asRecord(message?.request)?.subtype === "interrupt");
    expect(asRecord(interrupt?.request)).toMatchObject({ cancel_queued: true });
    f.fake.emit(line({ type: "control_response", response: { subtype: "success", request_id: interrupt?.request_id, response: {} } }));
    expect(await aborted).toMatchObject({ kind: "accepted" });
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: command.uuid, state: "cancelled" }));
    expect(await waiting).toMatchObject({ kind: "aborted" });
    expect(f.session.status().value.kind).toBe("idle");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(f.fake.killed()).toBe(false);
    expect(await f.session.prompt("still available")).toMatchObject({ kind: "accepted" });
  } finally { await f.session.dispose(); }
});

test("two queued inputs after compact remain two distinct turns", async () => {
  const f = await open();
  try {
    const waiting = f.compact(); const id = await f.dispatch();
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000002";
    await f.session.queue("first", { inputId: first });
    await f.session.queue("second", { inputId: second });
    f.fake.emit(line(boundary)); f.fake.emit(line(end(id)));
    expect(await waiting).toMatchObject({ kind: "completed" });
    await Promise.resolve(); await Promise.resolve();
    const users = () => f.fake.written.map((text) => asRecord(JSON.parse(text))).filter((message) => message?.type === "user");
    expect(users().map((message) => message?.uuid)).toEqual([id, first]);
    // Native has not acknowledged the first queued input yet. It already
    // owns the next turn, so a new prompt cannot overtake either queue entry.
    expect(await f.session.prompt("cannot overtake queue")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(users().map((message) => message?.uuid)).toEqual([id, first]);
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: first, state: "queued" }));
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: first, state: "started" }));
    f.fake.emit(line(end(first)));
    await Promise.resolve();
    expect(users().map((message) => message?.uuid)).toEqual([id, first, second]);
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: second, state: "started" }));
    f.fake.emit(line(end(second)));
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});


test("an interrupted ordinary turn cannot reclassify a native compact error as an aborted compaction", async () => {
  const f = await open();
  try {
    const waiting = f.compact(); const id = await f.dispatch();
    const aborted = f.session.abort();
    await vi.waitFor(() => { expect(f.fake.written.some((text) => text.includes('"subtype":"interrupt"'))).toBe(true); });
    const interrupt = f.fake.written.map((text) => asRecord(JSON.parse(text))).find((message) => asRecord(message?.request)?.subtype === "interrupt");
    f.fake.emit(line({ type: "control_response", response: { subtype: "success", request_id: interrupt?.request_id, response: {} } }));
    expect(await aborted).toMatchObject({ kind: "accepted" });
    f.fake.emit(line({ type: "system", subtype: "status", compact_result: "failed", compact_error: "cancelled" }));
    const nativeFailure = f.session.records().at(-1);
    expect(nativeFailure).toMatchObject({ kind: "frame", body: { native: { compact_result: "failed" } } });
    f.fake.emit(line(end(id, { is_error: true, errors: ["cancelled"] })));
    const result = await waiting;
    expect(result).toMatchObject({ kind: "failed", code: "native_failed" });
    assert.ok(result.kind === "failed");
    expect(result.frame).toBe(nativeFailure);
    expect(f.session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "aborted" } });
  } finally { await f.session.dispose(); }
});

test.each(["compact", "prompt"])("Claude %s result releases the gate at the same record that folds idle", async mode => {
  const f = await open(); const observed: { kind: string; prompt: ReturnType<typeof f.session.prompt> }[] = [];
  try {
    const pending = mode === "compact" ? f.compact() : f.session.prompt("first", { inputId: "11111111-1111-4111-8111-111111111111" });
    const id = await f.dispatch(); if (mode === "compact") { f.fake.emit(line(boundary)); }
    f.session.rawEvents(record => {
      if (record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended" && event.inputId === id)) { return; }
      observed.push({ kind: f.session.status().value.kind, prompt: f.session.prompt("next") });
    });
    f.fake.emit(line(end(id))); await pending;
    expect(observed).toHaveLength(1); expect(observed[0]?.kind).toBe("idle");
    expect(await observed[0]?.prompt).toMatchObject({ kind: "accepted" });
    expect(await f.session.prompt("cannot-overtake-next")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await f.session.dispose(); }
});

test.each(["prompt", "queue"] as const)("Claude terminal observer %s cannot overtake an OAR-held queue", async method => {
  const f = await open(); const observed: { kind: string; control: ReturnType<typeof f.session.prompt> }[] = [];
  try {
    await f.session.prompt("A"); const first = await f.dispatch();
    const queued = await f.session.queue("B");
    f.session.rawEvents(record => {
      if (observed.length > 0 || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
      observed.push({ kind: f.session.status().value.kind, control: f.session[method]("C") });
    });
    f.fake.emit(line(end(first)));
    const next = await observed[0]?.control;
    expect(next).toMatchObject(method === "prompt" ? { kind: "rejected", code: "busy" } : { kind: "accepted" });
    // The documented stream-json held-queue exception remains until its own follow-up.
    expect(observed[0]?.kind).toBe("idle");
    assert.ok(queued.request.body.kind === "queue");
    const second = queued.request.body.inputId;
    assert.ok(typeof second === "string");
    const writtenIds = () => f.fake.written.map(text => asRecord(JSON.parse(text))).filter(message => message?.type === "user").map(message => message?.uuid);
    expect(writtenIds()).toEqual([first, second]);
    f.fake.emit(line({ type: "command_lifecycle", command_uuid: second, state: "started" }));
    f.fake.emit(line(end(second)));
    if (method === "queue") {
      assert.ok(next?.request.body.kind === "queue");
      const third = next.request.body.inputId;
      assert.ok(typeof third === "string");
      expect(writtenIds()).toEqual([first, second, third]);
      f.fake.emit(line({ type: "command_lifecycle", command_uuid: third, state: "started" }));
      f.fake.emit(line(end(third)));
      expect(writtenIds()).toEqual([first, second, third]);
    } else { expect(writtenIds()).toEqual([first, second]); }
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});
