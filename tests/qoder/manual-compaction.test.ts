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
  launch.launchQoder.mockResolvedValue(fake);
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
