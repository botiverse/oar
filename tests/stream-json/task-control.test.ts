/* oxlint-disable eslint/max-statements -- Assert the complete control and replay sequence together. */
import { afterEach, expect, test, vi } from "vitest";
import { claudeProjectionProfile, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { withSessionCredentials } from "../../packages/oar/src/shared/session-credentials.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { streamJsonSession } from "../../packages/oar/src/shared/stream-json/session.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

afterEach(() => { vi.useRealTimers(); });
async function open(child: FakeLineProcess, supported = true) {
  return withSessionCredentials(async (_installation, _options, credentials) => streamJsonSession(child, "root", credentials, {
    projection: claudeProjectionProfile, initial: initialClaudeProjection,
    capabilities: { queue: { durable: false }, attribution: "attributed", images: false }, steer: false,
    consume: () => false, open: async () => {}, exited: () => {}, disposing: () => {},
    ...(supported ? { stopTask: (id: string) => ({ subtype: "stop_task", task_id: id }) } : {}),
  }))({ kind: "available", via: "executable", command: "fixture", version: "1" }, { cwd: "/work" });
}
function reply(child: FakeLineProcess, id: string, subtype = "success"): void {
  child.emit(`${JSON.stringify({ type: "control_response", response: { subtype, request_id: id, ...(subtype === "error" ? { error: "native refusal" } : { response: {} }) } })}\n`);
}

test("single-task acknowledgement precedes the next native frame and does not end any task or root turn", async () => {
  const child = fakeLineProcess(); const session = await open(child);
  try {
    const pending = session.stopTask?.("child-A");
    const request = asRecord(parseJson(child.written[0] ?? ""));
    expect(request?.request).toEqual({ subtype: "stop_task", task_id: "child-A" });
    expect(typeof request?.request_id).toBe("string");
    const id = String(request?.request_id);
    reply(child, id);
    child.emit(`${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "child-A", status: "stopped" })}\n`);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "accepted", request: { body: { kind: "stop_task", taskId: "child-A" } }, response: { body: { native: { type: "control_response" } } } });
    const events = session.records().flatMap(r => r.kind === "frame" ? r.body.events : []);
    expect(events).toEqual([{ kind: "task_ended", taskId: "child-A", status: "stopped" }]);
    expect(outcome?.response.seq).toBeLessThan(session.records().at(-1)?.seq ?? -1);
    expect(child.killed()).toBe(false);
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test("parallel task stops correlate independent replies and preserve duplicates as raw frames", async () => {
  const child = fakeLineProcess(); const session = await open(child);
  try {
    const a = session.stopTask?.("A"); const b = session.stopTask?.("B");
    const ids = child.written.map(line => String(asRecord(parseJson(line))?.request_id));
    reply(child, ids[1] ?? "", "error"); reply(child, ids[0] ?? ""); reply(child, ids[0] ?? "");
    expect(await a).toMatchObject({ kind: "accepted" });
    expect(await b).toMatchObject({ kind: "rejected", code: "runtime_refused", reason: "native refusal" });
    expect(session.records().filter(r => r.kind === "response" && ids.includes(r.requestId))).toHaveLength(2);
    expect(session.records().at(-1)).toMatchObject({ kind: "frame", body: { native: { response: { request_id: ids[0] } } } });
  } finally { await session.dispose(); }
});

test("unanswered stop expires without aborting the session and a late reply remains raw", async () => {
  vi.useFakeTimers(); const child = fakeLineProcess(); const session = await open(child);
  try {
    const pending = session.stopTask?.("A");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ kind: "rejected", code: "error" });
    expect(child.killed()).toBe(false);
    const request = asRecord(parseJson(child.written[0] ?? ""));
    reply(child, String(request?.request_id));
    expect(session.records().at(-1)?.kind).toBe("frame");
  } finally { await session.dispose(); }
});

test.each(["exit", "dispose"] as const)("pending task stop settles on %s and never sends after closure", async mode => {
  const child = fakeLineProcess(); const session = await open(child);
  const pending = session.stopTask?.("A");
  if (mode === "exit") { child.end(7); } else { await session.dispose(); }
  expect(await pending).toMatchObject({ kind: "rejected", code: mode === "exit" ? "runtime_exited" : "disposed" });
  const before = child.written.length;
  expect(await session.stopTask?.("B")).toMatchObject({ kind: "rejected" });
  expect(child.written).toHaveLength(before);
  await session.dispose();
});

test("a request observer can close the session before stop is sent", async () => {
  const child = fakeLineProcess(); const session = await open(child);
  session.rawEvents(record => { if (record.kind === "request" && record.body.kind === "stop_task") { child.end(0); } });
  expect(await session.stopTask?.("A")).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  expect(child.written).toEqual([]); await session.dispose();
});

test("an unsupported profile has no stopTask member", async () => {
  const session = await open(fakeLineProcess(), false);
  expect(Object.hasOwn(session, "stopTask")).toBe(false); await session.dispose();
});

test("stopping a child leaves the active root and its held input intact", async () => {
  const child = fakeLineProcess(); const session = await open(child);
  try {
    expect(await session.prompt("root A")).toMatchObject({ kind: "accepted" });
    const before = child.written.length;
    const stop = session.stopTask?.("child-A");
    const request = asRecord(parseJson(child.written[before] ?? ""));
    reply(child, String(request?.request_id));
    expect(await stop).toMatchObject({ kind: "accepted" });
    expect(session.status().value.kind).toBe("running");
    expect(child.written).toHaveLength(before + 1);
    expect(await session.prompt("new C")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(await session.queue("held B", { inputId: "00000000-0000-4000-8000-00000000000b" })).toMatchObject({ kind: "accepted" });
    child.emit(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
    const dispatched = asRecord(parseJson(child.written.at(-1) ?? ""));
    expect(dispatched?.uuid).toBe("00000000-0000-4000-8000-00000000000b");
    expect(child.killed()).toBe(false);
  } finally { await session.dispose(); }
});

test("a transport write failure settles only the task control and clears its timeout", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess(() => { throw new Error("write failed"); });
  const session = await open(child);
  try {
    expect(await session.stopTask?.("A")).toMatchObject({ kind: "rejected", code: "error", reason: "write failed" });
    const records = session.records().length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.records()).toHaveLength(records);
    expect(child.killed()).toBe(false);
  } finally { await session.dispose(); }
});
