import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "codex" } as const;

/** An app-server whose opened thread carries `name` (codex reports null for an unnamed one). */
function server(name: string | null, nameSet?: JsonRecord): JsonRecord[] {
  const requests: JsonRecord[] = [];
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (message?.id === undefined) { return; }
    requests.push(message);
    const opened = message.method === "thread/start" || message.method === "thread/resume";
    const reply = message.method === "thread/name/set" ? nameSet ?? { result: {} } : { result: opened ? { thread: { id: "thread", name: message.method === "thread/start" ? null : name } } : {} };
    child.emit(`${JSON.stringify({ id: message.id, ...reply })}\n`);
  }));
  return requests;
}

function nameSets(requests: readonly JsonRecord[]): unknown[] {
  return requests.filter((request) => request.method === "thread/name/set").map((request) => request.params);
}

test("a new thread gets the name once it opens", async () => {
  const requests = server(null);
  const session = await codexSession(installation, { cwd: "/work", name: "Raft · Otter" });
  await session.dispose();
  expect(nameSets(requests)).toEqual([{ threadId: "thread", name: "Raft · Otter" }]);
  const methods = requests.map((request) => request.method);
  expect(methods.indexOf("thread/name/set")).toBe(methods.indexOf("thread/start") + 1);
});

test.each([
  { current: null, expected: [{ threadId: "thread", name: "host name" }] },
  { current: "", expected: [{ threadId: "thread", name: "host name" }] },
  { current: "the user's own name", expected: [] },
])("a resumed thread named $current is named only when it has none", async ({ current, expected }) => {
  const requests = server(current);
  const session = await codexSession(installation, { cwd: "/work", resume: "thread", name: "host name" });
  await session.dispose();
  expect(nameSets(requests)).toEqual(expected);
});

test("no name option sends no thread/name/set", async () => {
  const requests = server(null);
  const session = await codexSession(installation, { cwd: "/work" });
  await session.dispose();
  expect(nameSets(requests)).toEqual([]);
});

test("a name codex refuses is recorded and the session still opens", async () => {
  const requests = server(null, { error: { code: -32_601, message: "Method not found" } });
  const session = await codexSession(installation, { cwd: "/work", name: "host name" });
  const refusal = session.records().find((record) => record.kind === "frame" && record.body.type === "thread/name/set/error");
  expect(refusal).toMatchObject({ body: { native: { code: -32_601, message: "Method not found" }, events: [] } });
  expect(session.status().value.kind).toBe("idle");
  await session.dispose();
  expect(nameSets(requests)).toHaveLength(1);
});

test("a lost connection while naming still fails the open", async () => {
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (message?.id === undefined) { return; }
    if (message.method === "thread/name/set") { child.end(1); return; }
    const opened = message.method === "thread/start";
    child.emit(`${JSON.stringify({ id: message.id, result: opened ? { thread: { id: "thread", name: null } } : {} })}\n`);
  }));
  await expect(codexSession(installation, { cwd: "/work", name: "host name" })).rejects.toThrow("codex thread/name/set failed");
});

test("the app-server starts in the session directory", async () => {
  server(null);
  const session = await codexSession(installation, { cwd: "/work/session" });
  await session.dispose();
  expect(spawnLineProcess.mock.calls[0]?.[2]).toMatchObject({ cwd: "/work/session" });
});
