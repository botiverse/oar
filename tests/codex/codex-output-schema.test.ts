/* oxlint-disable max-statements -- Each test follows a complete control sequence. */
import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "codex" } as const;
const outputSchema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"] };
const threadId = "thread";
function notify(child: FakeLineProcess, method: string, params: JsonRecord): void { child.emit(`${JSON.stringify({ method, params: { threadId, ...params } })}\n`); }
function server(): { child: FakeLineProcess; requests: JsonRecord[] } {
  const requests: JsonRecord[] = [];
  const child = fakeLineProcess((line, process) => {
    const message = asRecord(parseJson(line));
    if (message?.id === undefined) { return; }
    requests.push(message);
    const { method } = message;
    let result: JsonRecord = {};
    if (method === "thread/start" || method === "thread/resume") { result = { thread: { id: threadId }, model: "gpt-5.1" }; }
    if (method === "turn/start") { result = { turn: { id: "turn" } }; }
    process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
    if (method === "turn/start") {
      notify(process, "turn/started", { turn: { id: "turn" } });
      const input = asRecord(message.params)?.input;
      if (Array.isArray(input) && asRecord(input[0])?.text !== "hold") {
        notify(process, "item/agentMessage/delta", { turnId: "turn", delta: "not JSON" });
        notify(process, "turn/completed", { turn: { id: "turn", status: "completed" } });
      }
    }
  });
  spawnLineProcess.mockReturnValue(child);
  return { child, requests };
}

test.each([undefined, "thread"])("every prompted turn carries schema, including resume %s, and output stays text", async (resume) => {
  const { requests } = server();
  const session = await codexSession(installation, { cwd: "/work", outputSchema, ...(resume === undefined ? {} : { resume }) });
  try {
    expect(await promptAndWait(session, "one")).toMatchObject({ kind: "ended", text: "not JSON", outcome: { kind: "completed" } });
    expect(await promptAndWait(session, "two")).toMatchObject({ kind: "ended", text: "not JSON", outcome: { kind: "completed" } });
    expect(requests.filter((request) => request.method === "turn/start").map((request) => asRecord(request.params)?.outputSchema)).toEqual([outputSchema, outputSchema]);
    expect(session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" } });
    const queued = await session.queue("queued");
    expect(queued).toMatchObject({ kind: "rejected", code: "unsupported" });
    if (queued.kind === "rejected") { expect(queued.reason).toContain("queued input cannot carry outputSchema"); }
    expect(requests.some((request) => request.method === "thread/queue/add")).toBe(false);
  } finally { await session.dispose(); }
});

test("steer stays in the existing turn and a schema-free session keeps native queue support", async () => {
  const { requests } = server();
  const session = await codexSession(installation, { cwd: "/work", outputSchema });
  try {
    await session.prompt("hold");
    expect(await session.steer?.("change")).toMatchObject({ kind: "accepted" });
    const steered = requests.find((request) => request.method === "turn/steer");
    expect(steered?.params).not.toHaveProperty("outputSchema");
  } finally { await session.dispose(); }
  const next = server();
  const plain = await codexSession(installation, { cwd: "/work" });
  try {
    expect(await plain.queue("next")).toMatchObject({ kind: "accepted" });
    expect(next.requests.some((request) => request.method === "thread/queue/add")).toBe(true);
  } finally { await plain.dispose(); }
});
