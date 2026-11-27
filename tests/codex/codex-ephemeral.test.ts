import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { codexOpenReadback, codexThreadOpen } from "../../packages/oar/src/runtimes/codex/open.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "codex" } as const;

function server(threadReply: JsonRecord): JsonRecord[] {
  const requests: JsonRecord[] = [];
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    const message = asRecord(parseJson(line));
    if (message?.id === undefined) { return; }
    requests.push(message);
    const opened = message.method === "thread/start" || message.method === "thread/fork";
    child.emit(`${JSON.stringify({ id: message.id, result: opened ? { thread: threadReply } : {} })}\n`);
  }));
  return requests;
}

test("codexThreadOpen passes ephemeral: true on thread/start and thread/fork and omits it otherwise", () => {
  expect(codexThreadOpen({ cwd: "/work", ephemeral: true }).params).toMatchObject({ cwd: "/work", ephemeral: true });
  expect(codexThreadOpen({ cwd: "/work", resume: "src", fork: {}, ephemeral: true }).params).toMatchObject({ threadId: "src", ephemeral: true });
  expect(codexThreadOpen({ cwd: "/work" }).params).not.toHaveProperty("ephemeral");
  expect(codexThreadOpen({ cwd: "/work", ephemeral: false }).params).not.toHaveProperty("ephemeral");
});

test("ephemeral with resume without fork or with name on codex is refused before anything starts", async () => {
  await expect(codexSession(installation, { cwd: "/work", resume: "saved", ephemeral: true })).rejects.toMatchObject({
    name: "UnsupportedOptionError",
    option: "ephemeral",
  });
  await expect(codexSession(installation, { cwd: "/work", ephemeral: true, name: "tmp" })).rejects.toMatchObject({
    name: "UnsupportedOptionError",
    option: "ephemeral",
  });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("codexSession opens an ephemeral thread when codex confirms thread.ephemeral: true and omits nativeSessionFile", async () => {
  const requests = server({ id: "ephem-1", ephemeral: true, path: null });
  const session = await codexSession(installation, { cwd: "/work", ephemeral: true });
  expect(session.id).toBe("ephem-1");
  expect("nativeSessionFile" in session).toBe(false);
  const startReq = requests.find((request) => request.method === "thread/start");
  expect(startReq?.params).toMatchObject({ cwd: "/work", ephemeral: true });
  await session.dispose();
});

test("codexSession opens an ephemeral fork when codex confirms thread.ephemeral: true", async () => {
  const requests = server({ id: "fork-ephem-1", ephemeral: true, path: null });
  const session = await codexSession(installation, { cwd: "/work", resume: "src-1", fork: {}, ephemeral: true });
  expect(session.id).toBe("fork-ephem-1");
  const forkReq = requests.find((request) => request.method === "thread/fork");
  expect(forkReq?.params).toMatchObject({ threadId: "src-1", ephemeral: true });
  await session.dispose();
});

test("codexSession refuses to open when codex does not confirm ephemeral on readback", async () => {
  server({ id: "persisted-1", ephemeral: false, path: "/tmp/persisted-1.jsonl" });
  await expect(codexSession(installation, { cwd: "/work", ephemeral: true })).rejects.toThrow("reported ephemeral=false although ephemeral was requested");

  const omitted = codexOpenReadback("thread/start", { cwd: "/work", ephemeral: true }, { thread: { id: "old-codex" } });
  expect(omitted.refusal).toContain("did not confirm ephemeral");
  expect(codexOpenReadback("thread/start", { cwd: "/work", ephemeral: true }, { thread: { id: "ok", ephemeral: true } }).refusal).toBeNull();
  expect(() => codexThreadOpen({ cwd: "/work", resume: "saved", ephemeral: true })).toThrow(UnsupportedOptionError);
});
