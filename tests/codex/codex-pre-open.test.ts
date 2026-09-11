import { afterEach, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../packages/oar/src/contracts/session.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.154.0" } as const;
const threadId = "thread-pre";

afterEach(() => {
  spawnLineProcess.mockReset();
});

function describe(record: SessionRecord): string {
  switch (record.kind) {
    case "event":
      return `event ${record.body.type}`;
    case "request":
      return `${record.direction} ${record.body.kind === "native" ? record.body.type : record.body.kind}`;
    case "response":
      return record.body.kind === "exited"
        ? `response exited code=${String(record.body.code)} for=${JSON.stringify(record.requestId)}`
        : `response ${record.body.kind}`;
    default:
      return "?";
  }
}

/**
 * The app-server talks before the thread exists: on 0.144.6 an unsolicited
 * notification followed the initialize reply. Those frames are the runtime's
 * words too, so the client holds them until the adapter's handler exists and
 * the stream records them first, in arrival order, ahead of the open event.
 */
test("notifications and server requests sent before thread/start are recorded first, in order", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    if (message.method === "initialize") {
      process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      process.emit(`${JSON.stringify({ method: "remoteControl/status/changed", params: { status: "off" } })}\n`);
      process.emit(`${JSON.stringify({ id: "srv-1", method: "account/login/required", params: {} })}\n`);
      return;
    }
    if (message.method === "thread/start") {
      process.emit(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId }, model: "gpt-5.5" } })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  expect(session.records().slice(0, 3).map((record) => describe(record))).toEqual([
    "event remoteControl/status/changed",
    "toApp account/login/required",
    "event thread/start",
  ]);
  await session.dispose();
});

test("a server request before a notification keeps its wire order ahead of the open event", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    if (message.method === "initialize") {
      process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      process.emit(`${JSON.stringify({ id: "srv-1", method: "account/login/required", params: {} })}\n`);
      process.emit(`${JSON.stringify({ method: "remoteControl/status/changed", params: { status: "off" } })}\n`);
      return;
    }
    if (message.method === "thread/start") {
      process.emit(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId }, model: "gpt-5.5" } })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  expect(session.records().slice(0, 3).map((record) => describe(record))).toEqual([
    "toApp account/login/required",
    "event remoteControl/status/changed",
    "event thread/start",
  ]);
  await session.dispose();
});

/**
 * The thread/start reply and thread/started often share one stdout chunk.
 * The open event is marked at the reply's wire position (synchronously, as
 * the reply line is read), so the frame codex wrote right after the reply
 * lands after the open event; a promise continuation would have let it in
 * first.
 */
test("the open event precedes a thread/started written in the same chunk as the reply", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    if (message.method === "initialize") {
      process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      return;
    }
    if (message.method === "thread/start") {
      process.emit([
        { id: message.id, result: { thread: { id: threadId }, model: "gpt-5.5" } },
        { method: "thread/started", params: { thread: { id: threadId } } },
        { method: "thread/status/changed", params: { threadId, status: { type: "idle" } } },
      ].map((frame) => `${JSON.stringify(frame)}\n`).join(""));
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  expect(session.records().slice(0, 3).map((record) => describe(record))).toEqual([
    "event thread/start",
    "event thread/started",
    "event thread/status/changed",
  ]);
  await session.dispose();
});

test("control after the app-server died on its own is rejected, and a later dispose is answered", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    const result = message.method === "initialize" ? {} : { thread: { id: threadId }, model: "gpt-5.5" };
    process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  fake.end(137);
  expect(session.records().slice(-1).map((record) => describe(record))).toEqual(["response exited code=137 for=\"\""]);
  const after = await session.prompt("hello?");
  expect(after.response.body).toEqual({ kind: "rejected", reason: "runtime exited" });
  await session.dispose();
  expect(session.records().slice(-2).map((record) => describe(record))).toEqual(["toRuntime dispose", "response accepted"]);
});
