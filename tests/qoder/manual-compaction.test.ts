/* oxlint-disable eslint/max-statements -- Keep lifecycle, boundary, ordinary result and queue ordering together. */
import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const launch = vi.hoisted(() => ({ launchQoder: vi.fn(), closeQoder: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => launch);
afterEach(() => { vi.clearAllMocks(); });
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
async function open() {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (message?.type !== "control_request") { return; }
    process.emit(line({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }));
  });
  launch.launchQoder.mockResolvedValue(Object.assign(fake, { qoderVersion: "1.1.81" }));
  launch.closeQoder.mockImplementation(async () => { fake.end(0); await fake.exited; });
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture", version: "1.1.81" }, { cwd: "/work" });
  assert.ok(session.compact !== undefined);
  return { session, compact: session.compact.bind(session), fake, emit: (value: unknown) => { fake.emit(line(value)); },
    input: () => { const message = fake.written.map(text => asRecord(JSON.parse(text))).find(x => x?.type === "user"); assert.ok(typeof message?.uuid === "string"); return message.uuid; } };
}
const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } };
test.each(["completed", "cancelled"] as const)("a Qoder manual boundary remains completed after command %s, without borrowing another command", async (state) => {
  const f = await open();
  try {
    const waiting = f.compact(); const id = f.input();
    await f.session.queue("held");
    f.emit(boundary); // No matching start yet.
    f.emit({ type: "command_lifecycle", command_uuid: "other", state: "completed" });
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
    f.emit({ type: "command_lifecycle", command_uuid: id, state: "started" });
    f.emit(boundary);
    f.emit({ type: "result", subtype: "success", is_error: false });
    expect(await f.session.prompt("overtake")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.fake.written.some(text => text.includes("held"))).toBe(false);
    f.emit({ type: "command_lifecycle", command_uuid: id, state });
    expect(await waiting).toMatchObject({ kind: "completed", frame: { body: { type: "system/compact_boundary" } } });
    expect(f.fake.written.some(text => text.includes("held"))).toBe(true);
  } finally { await f.session.dispose(); }
});
test.each(["empty", "error", "cancelled"] as const)("Qoder %s without a boundary preserves the separate native facts", async (mode) => {
  const f = await open();
  try {
    const waiting = f.compact(); const id = f.input();
    f.emit({ type: "command_lifecycle", command_uuid: id, state: "started" });
    f.emit({ ...boundary, parent_tool_use_id: "child" });
    f.emit({ ...boundary, compact_metadata: { trigger: "auto" } });
    f.emit({ type: "result", subtype: "success", is_error: mode === "error" });
    f.emit({ type: "command_lifecycle", command_uuid: id, state: mode === "cancelled" ? "cancelled" : "completed" });
    expect(await waiting).toMatchObject(mode === "cancelled" ? { kind: "aborted" } : { kind: "failed", code: mode === "empty" ? "not_compacted" : "native_failed" });
  } finally { await f.session.dispose(); }
});

test.each([true, false])("Qoder command terminal releases the gate before observers see idle, result present: %s", async result => {
  const f = await open(); const observed: { kind: string; prompt: ReturnType<typeof f.session.prompt> }[] = [];
  try {
    const pending = f.compact(); const id = f.input();
    f.emit({ type: "command_lifecycle", command_uuid: id, state: "started" }); f.emit(boundary);
    if (result) { f.emit({ type: "result", subtype: "success", is_error: false }); }
    expect(f.session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
    expect(await f.session.prompt("before-command-end")).toMatchObject({ kind: "rejected", code: "busy" });
    f.session.rawEvents(record => {
      if (record.kind !== "frame" || asRecord(record.body.native)?.command_uuid !== id || asRecord(record.body.native)?.state !== "completed") { return; }
      observed.push({ kind: f.session.status().value.kind, prompt: f.session.prompt("next") });
    });
    f.emit({ type: "command_lifecycle", command_uuid: id, state: "completed" }); await pending;
    expect(observed).toHaveLength(1); expect(observed[0]?.kind).toBe("idle");
    expect(await observed[0]?.prompt).toMatchObject({ kind: "accepted" });
    expect(await f.session.prompt("cannot-overtake-next")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await f.session.dispose(); }
});

test.each([["prompt", true], ["queue", true], ["prompt", false], ["queue", false]] as const)("Qoder terminal observer %s respects held queue: %s", async (method, held) => {
  const f = await open(); const observed: { kind: string; control: ReturnType<typeof f.session.prompt> }[] = [];
  try {
    await f.session.prompt("A"); const first = f.input();
    f.emit({ type: "command_lifecycle", command_uuid: first, state: "started" });
    const queued = held ? await f.session.queue("B") : undefined;
    f.session.rawEvents(record => {
      if (observed.length > 0 || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
      observed.push({ kind: f.session.status().value.kind, control: f.session[method]("C") });
    });
    f.emit({ type: "result", subtype: "success", is_error: false });
    const next = await observed[0]?.control;
    expect(next).toMatchObject(held && method === "prompt" ? { kind: "rejected", code: "busy" } : { kind: "accepted" });
    const second = queued?.request.body ?? next?.request.body;
    expect(observed[0]?.kind).toBe("idle");
    assert.ok(second?.kind === "queue" || second?.kind === "prompt");
    const writtenIds = () => f.fake.written.map(text => asRecord(JSON.parse(text))).filter(message => message?.type === "user").map(message => message?.uuid);
    expect(writtenIds()).toEqual([first, second.inputId]);
    f.emit({ type: "command_lifecycle", command_uuid: second.inputId, state: "started" });
    f.emit({ type: "result", subtype: "success", is_error: false });
    if (held && method === "queue") {
      assert.ok(next?.request.body.kind === "queue");
      const third = next.request.body.inputId;
      expect(writtenIds()).toEqual([first, second.inputId, third]);
      f.emit({ type: "command_lifecycle", command_uuid: third, state: "started" });
      f.emit({ type: "result", subtype: "success", is_error: false });
      expect(writtenIds()).toEqual([first, second.inputId, third]);
    } else { expect(writtenIds()).toEqual([first, second.inputId]); }
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});
