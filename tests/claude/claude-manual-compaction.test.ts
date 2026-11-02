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
