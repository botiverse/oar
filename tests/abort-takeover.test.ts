import { afterEach, expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../packages/oar/src/runtimes/codex/session.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "./fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });

/** Answer codex setup and prompt; both runtimes' interrupts remain unanswered. */
function script(text: string, child: FakeLineProcess): void {
  const message = asRecord(parseJson(text));
  if (typeof message?.id !== "number" || message.method === "turn/interrupt") { return; }
  let result = {};
  if (message.method === "thread/start") { result = { thread: { id: "thread" }, model: "test" }; }
  if (message.method === "turn/start") { result = { turn: { id: "turn" } }; }
  child.emit(`${JSON.stringify({ id: message.id, result })}\n`);
}

function lateReply(fake: FakeLineProcess, runtime: string, abortId: string): unknown {
  if (runtime === "claude") {
    const native = { type: "control_response", response: { subtype: "error", request_id: abortId } };
    fake.stdout.emit("data", `${JSON.stringify(native)}\n`);
    return native;
  }
  const sent = fake.written.map((text) => asRecord(parseJson(text))).find((entry) => entry?.method === "turn/interrupt");
  const native = { code: -1, message: "late refusal", data: { why: "already stopping" } };
  fake.stdout.emit("data", `${JSON.stringify({ id: sent?.id, error: native })}\n`);
  return native;
}

test.each([
  { id: "claude", open: claudeSession, replyAfterExit: false },
  { id: "claude", open: claudeSession, replyAfterExit: true },
  { id: "codex", open: codexSession, replyAfterExit: false },
  { id: "codex", open: codexSession, replyAfterExit: true },
// oxlint-disable-next-line eslint/max-statements -- Keep the takeover, delayed exit and late native reply on one process.
])("$id fallback accepts before killing; late reply after exit: $replyAfterExit", async ({ id, open, replyAfterExit }) => {
  vi.useFakeTimers();
  const fake = fakeLineProcess(script);
  const kill = vi.spyOn(fake, "kill").mockImplementation(() => {});
  spawnLineProcess.mockReturnValue(fake);
  const session = await open({ kind: "available", via: "executable", command: id, version: "test" }, { cwd: "/work" });
  kill.mockImplementation(() => {
    expect(session.records().at(-1)).toMatchObject({ kind: "response", body: { kind: "accepted" } });
  });
  const prompt = await session.prompt("hold");
  const ended = awaitTurnEnd(session, prompt.seq);
  const abort = session.abort();
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await abort;
  expect(result.response.body).toMatchInlineSnapshot(`
    {
      "kind": "accepted",
    }
  `);
  expect(kill).toHaveBeenCalledOnce();
  expect(session.status().value.kind).toBe("running");
  expect(session.records().some((entry) => entry.kind === "response" && entry.body.kind === "exited")).toBe(false);
  const repeated = await session.abort();
  expect(repeated.response.body).toMatchInlineSnapshot(`
    {
      "kind": "accepted",
    }
  `);
  expect(kill).toHaveBeenCalledOnce();
  if (replyAfterExit) { fake.end(null); }
  const native = lateReply(fake, id, result.request.id);
  expect(session.records().at(-1)).toMatchObject({ kind: "frame", body: { native, events: [] } });
  expect(session.records().filter((entry) => entry.kind === "response" && entry.requestId === result.request.id)).toEqual([result.response]);
  fake.end(null);
  expect(await ended).toMatchInlineSnapshot(`
    {
      "kind": "aborted",
    }
  `);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Exercise the real RPC redactor after a fallback already answered the control.
test("a late codex refusal retains error details but redacts MCP credentials inside strings", async () => {
  vi.useFakeTimers();
  const fake = fakeLineProcess(script);
  vi.spyOn(fake, "kill").mockImplementation(() => {});
  spawnLineProcess.mockReturnValue(fake);
  const secret = 'fake-token-with-"quotes"\nand-newline';
  const session = await codexSession({ kind: "available", via: "executable", command: "codex", version: "test" }, {
    cwd: "/work", mcpServers: [{ name: "echo", command: "echo", env: { TOKEN: secret } }],
  });
  await session.prompt("hold");
  const abort = session.abort();
  await vi.advanceTimersByTimeAsync(10_000);
  await abort;
  const sent = fake.written.map((text) => asRecord(parseJson(text))).find((entry) => entry?.method === "turn/interrupt");
  fake.emit(`${JSON.stringify({ id: sent?.id, error: { code: -1, message: `refused ${secret}`, data: { credential: secret, details: [secret] } } })}\n`);
  const last = session.records().at(-1);
  expect(last?.kind === "frame" ? last.body.native : null).toMatchInlineSnapshot(`
    {
      "code": -1,
      "data": {
        "credential": "[redacted]",
        "details": [
          "[redacted]",
        ],
      },
      "message": "refused [redacted]",
    }
  `);
  fake.end(null);
  await session.dispose();
});
