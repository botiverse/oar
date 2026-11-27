import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/index.js";
import { codexOpenReadback, codexThreadOpen } from "../../packages/oar/src/runtimes/codex/open.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "codex", version: "0.172.0" } as const;

interface ServerHandle {
  readonly requests: JsonRecord[];
  readonly emit: (notification: JsonRecord) => void;
  readonly finishTurn: (turnId: string, status?: string) => void;
}

function sendJson(child: FakeLineProcess, payload: JsonRecord): void {
  child.emit(`${JSON.stringify(payload)}\n`);
}

function handleMessage(
  child: FakeLineProcess,
  message: JsonRecord,
  context: { readonly threadReply: JsonRecord; readonly threadId: string; readonly userAgent?: string | undefined; turns: number },
): void {
  if (message.method === "initialize") {
    sendJson(child, { id: message.id, result: context.userAgent === undefined ? {} : { userAgent: context.userAgent } });
  } else if (message.method === "thread/start" || message.method === "thread/fork") {
    sendJson(child, { id: message.id, result: { thread: context.threadReply } });
  } else if (message.method === "turn/start") {
    context.turns += 1;
    const turnId = `turn-${String(context.turns)}`;
    sendJson(child, { id: message.id, result: { turn: { id: turnId } } });
    sendJson(child, { method: "turn/started", params: { threadId: context.threadId, turn: { id: turnId } } });
  } else {
    sendJson(child, { id: message.id, result: {} });
  }
}

function server(threadReply: JsonRecord, userAgent?: string): ServerHandle {
  const requests: JsonRecord[] = [];
  let processHandle: FakeLineProcess | null = null;
  const threadId = typeof threadReply.id === "string" ? threadReply.id : "ephem-1";
  const context = { threadReply, threadId, userAgent, turns: 0 };
  spawnLineProcess.mockReturnValue(fakeLineProcess((line, child) => {
    processHandle = child;
    const message = asRecord(parseJson(line));
    if (message?.id === undefined) { return; }
    requests.push(message);
    handleMessage(child, message, context);
  }));
  return {
    requests,
    emit: (notification) => { if (processHandle !== null) { sendJson(processHandle, notification); } },
    finishTurn: (turnId, status = "completed") => {
      if (processHandle !== null) { sendJson(processHandle, { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } }); }
    },
  };
}

test("codexThreadOpen passes ephemeral: true on thread/start and thread/fork and omits it otherwise", () => {
  expect(codexThreadOpen({ cwd: "/work", ephemeral: true }).params).toMatchObject({ cwd: "/work", ephemeral: true });
  expect(codexThreadOpen({ cwd: "/work", resume: "src", fork: {}, ephemeral: true }).params).toMatchObject({ threadId: "src", ephemeral: true });
  expect(codexThreadOpen({ cwd: "/work" }).params).not.toHaveProperty("ephemeral");
  expect(codexThreadOpen({ cwd: "/work", ephemeral: false }).params).not.toHaveProperty("ephemeral");
});

test("ephemeral with resume without fork, with name, with goals, or below version floor refuses before spawn", async () => {
  await expect(codexSession(installation, { cwd: "/work", resume: "saved", ephemeral: true })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "ephemeral" });
  await expect(codexSession(installation, { cwd: "/work", ephemeral: true, name: "tmp" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "ephemeral" });
  await expect(codexSession(installation, { cwd: "/work", ephemeral: true, goals: true })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "ephemeral" });
  await expect(codexSession({ kind: "available", via: "executable", command: "codex", version: "0.168.0" }, { cwd: "/work", ephemeral: true })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "ephemeral" });
  await expect(codexSession({ kind: "available", via: "executable", command: "codex" }, { cwd: "/work", ephemeral: true })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "ephemeral" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("openThread refuses ephemeral unsent when initialize reports a binary below 0.169.0", async () => {
  const srv = server({ id: "should-not-open", ephemeral: true, path: null }, "codex/0.168.0 (linux)");
  await expect(codexSession(installation, { cwd: "/work", ephemeral: true })).rejects.toMatchObject({ code: "runtime_outdated" });
  expect(srv.requests.some((request) => request.method === "thread/start" || request.method === "thread/fork")).toBe(false);
});

test("codexSession opens ephemeral thread/start with adapter-held queue, withdraw, and no nativeSessionFile", async () => {
  const srv = server({ id: "ephem-1", ephemeral: true, path: null });
  const session = await codexSession(installation, { cwd: "/work", ephemeral: true });
  expect(session.id).toBe("ephem-1");
  expect("nativeSessionFile" in session).toBe(false);
  expect(session.capabilities.queue.durable).toBe(false);
  expect("withdraw" in session).toBe(true);
  expect(srv.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({ cwd: "/work", ephemeral: true });
  await session.dispose();
});

test("codexSession opens ephemeral thread/fork with adapter-held queue and withdraw", async () => {
  const forkSrv = server({ id: "fork-ephem-1", ephemeral: true, path: null });
  const forked = await codexSession(installation, { cwd: "/work", resume: "src-1", fork: {}, ephemeral: true });
  expect(forked.id).toBe("fork-ephem-1");
  expect("nativeSessionFile" in forked).toBe(false);
  expect(forked.capabilities.queue.durable).toBe(false);
  expect("withdraw" in forked).toBe(true);
  expect(forkSrv.requests.find((request) => request.method === "thread/fork")?.params).toMatchObject({ threadId: "src-1", ephemeral: true });
  await forked.dispose();
});

function turnStarts(srv: ServerHandle): readonly JsonRecord[] {
  return srv.requests.filter((request) => request.method === "turn/start");
}

function finishCompact(srv: ServerHandle, threadId: string): void {
  srv.emit({ method: "item/started", params: { threadId, turnId: "compact-1", item: { id: "c-1", type: "contextCompaction" } } });
  srv.emit({ method: "item/completed", params: { threadId, turnId: "compact-1", item: { id: "c-1", type: "contextCompaction" } } });
  srv.finishTurn("compact-1");
}

async function withEphemeralSession(id: string, body: (srv: ServerHandle, session: Awaited<ReturnType<typeof codexSession>>) => Promise<void>): Promise<void> {
  const srv = server({ id, ephemeral: true, path: null });
  const session = await codexSession(installation, { cwd: "/work", ephemeral: true });
  try { await body(srv, session); } finally { await session.dispose(); }
}

const DROP_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const COMPACT_ID = "00000000-0000-4000-8000-000000000003";

test("ephemeral queue holds inputs in adapter, withdraws before drain, and drains via turn/start", async () => {
  await withEphemeralSession("ephem-q", async (srv, session) => {
    const [prompted, q1, q2] = await Promise.all([session.prompt("first"), session.queue("drop me", { inputId: DROP_ID }), session.queue("run me", { inputId: RUN_ID })]);
    expect([prompted.kind, q1.response.body, q2.response.body, srv.requests.some((request) => request.method === "thread/queue/add")]).toEqual(["accepted", { kind: "accepted", queued: "adapter" }, { kind: "accepted", queued: "adapter" }, false]);
    expect(await session.withdraw?.(DROP_ID)).toMatchObject({ kind: "accepted" });
    const waitingQ2 = awaitTurnEnd(session, q2.request.seq, RUN_ID);
    srv.finishTurn("turn-1");
    await expect.poll(() => turnStarts(srv).length).toBe(2);
    const [, secondTurnReq] = turnStarts(srv);
    expect(secondTurnReq?.params).toMatchObject({ clientUserMessageId: RUN_ID, input: [{ type: "text", text: "run me" }] });
    srv.finishTurn("turn-2");
    expect(await waitingQ2).toEqual({ kind: "completed" });
  });
});

test("ephemeral queue coordinates with manual compaction: blocks during compaction and drains on release", async () => {
  await withEphemeralSession("ephem-c", async (srv, session) => {
    const compacting = session.compact?.();
    await expect.poll(() => srv.requests.some((request) => request.method === "thread/compact/start")).toBe(true);
    const queued = await session.queue("after compact", { inputId: COMPACT_ID });
    expect([queued.response.body, turnStarts(srv).length]).toEqual([{ kind: "accepted", queued: "adapter" }, 0]);
    finishCompact(srv, "ephem-c");
    expect(await compacting).toMatchObject({ kind: "completed" });
    await expect.poll(() => turnStarts(srv).length).toBe(1);
    srv.finishTurn("turn-1");
    expect(await awaitTurnEnd(session, queued.request.seq, COMPACT_ID)).toEqual({ kind: "completed" });
  });
});

test("codexSession refuses to open when codex does not confirm ephemeral on readback", async () => {
  server({ id: "persisted-1", ephemeral: false, path: "/tmp/persisted-1.jsonl" });
  await expect(codexSession(installation, { cwd: "/work", ephemeral: true })).rejects.toThrow("reported ephemeral=false although ephemeral was requested");

  const omitted = codexOpenReadback("thread/start", { cwd: "/work", ephemeral: true }, { thread: { id: "old-codex" } });
  expect(omitted.refusal).toContain("did not confirm ephemeral");
  expect(codexOpenReadback("thread/start", { cwd: "/work", ephemeral: true }, { thread: { id: "ok", ephemeral: true } }).refusal).toBeNull();
  expect(() => codexThreadOpen({ cwd: "/work", resume: "saved", ephemeral: true })).toThrow(UnsupportedOptionError);
});
