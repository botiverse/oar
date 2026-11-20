/* oxlint-disable eslint/max-statements -- Exercise two distinct native turn/interrupt error payloads sequentially. */
import { afterEach, expect, test, vi } from "vitest";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.fn<() => FakeLineProcess>();
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({
  ...await original<Record<string, unknown>>(),
  spawnLineProcess: (): FakeLineProcess => spawnLineProcess(),
}));

const { codexSession } = await import("../../packages/oar/src/runtimes/codex/session.js");

const installation = { kind: "available", via: "executable", command: "/fake/codex", version: "0.171.0" } as const;
const threadId = "00000000-0000-4000-8000-000000000001";

afterEach(() => { spawnLineProcess.mockReset(); });

async function openWithInterruptError(error: JsonRecord) {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") { return; }
    switch (message.method) {
      case "initialize":
        process.emit(`${JSON.stringify({ id: message.id, result: { userAgent: "codex/0.171.0" } })}\n`);
        break;
      case "thread/start":
        process.emit(`${JSON.stringify({ id: message.id, result: { thread: { id: threadId }, model: "gpt-5.5" } })}\n`);
        break;
      case "turn/start":
        process.emit(`${JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } })}\n`);
        break;
      case "turn/interrupt":
        process.emit(`${JSON.stringify({ id: message.id, error })}\n`);
        break;
      default:
        process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await codexSession(installation, { cwd: "/work" });
  return session;
}

test("Codex turn/interrupt refusal uses codexControlRefusal for session_not_found and failure class", async () => {
  const notFound = { code: -32_600, message: `thread not found: ${threadId}` };
  const s1 = await openWithInterruptError(notFound);
  try {
    await s1.prompt("hold");
    const aborted = await s1.abort();
    expect(aborted.response.body).toEqual({ kind: "rejected", code: "session_not_found", reason: notFound.message, native: notFound });
  } finally { await s1.dispose(); }

  const overloaded = { code: -32_001, message: "request queue full" };
  const s2 = await openWithInterruptError(overloaded);
  try {
    await s2.prompt("hold");
    const aborted = await s2.abort();
    expect(aborted.response.body).toEqual({ kind: "rejected", code: "runtime_refused", failure: "overloaded", reason: overloaded.message, native: overloaded });
  } finally { await s2.dispose(); }
});
