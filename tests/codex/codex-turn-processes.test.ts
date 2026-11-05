/* oxlint-disable eslint/max-lines, eslint/max-statements, eslint/max-params, eslint/init-declarations, eslint/no-nested-ternary, import/max-dependencies, unicorn/no-await-expression-member, typescript/unbound-method -- Every branch of one guard shares the scripted app-server and process table below. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi, type Mock, type MockInstance } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { defineRuntime } from "../../packages/oar/src/contracts/runtime.js";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { codexRuntime } from "../../packages/oar/src/runtimes/codex/index.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import type { CancellationObservation } from "../../packages/oar/src/shared/executable/process-cancellation.js";
// oxlint-disable-next-line import/no-namespace -- Script each table read while keeping the budget module's export shape.
import * as budget from "../../packages/oar/src/shared/executable/process-table-budget.js";
import { observeProcessTable, type ProcessEntry, type ProcessTableObservation } from "../../packages/oar/src/shared/executable/process-tree.js";
import { endTurnEntries, turnEntries, type ProcessTableReading } from "../../packages/oar/src/shared/executable/process-turn-scope.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex" } as const;
const threadId = "thread-1";
const ROOT = 910_000;
const HOST_GROUP = 910_001;
/** The launcher case: the spawned root's native child runs the commands. */
const NATIVE = 910_002;
const MCP = 910_003;
const EARLIER = 910_004;
const COMMAND = 910_005;
const DETACHED = 910_006;

function entry(pid: number, ppid: number, pgid: number = pid, start = "100"): ProcessEntry { return { pid, ppid, pgid, start }; }
const host = entry(process.pid, 1, HOST_GROUP);
const root = entry(ROOT, process.pid);
const native = entry(NATIVE, ROOT, ROOT);
const mcp = entry(MCP, NATIVE);
const earlier = entry(EARLIER, NATIVE);
const command = entry(COMMAND, NATIVE, COMMAND, "200");
const detached = entry(DETACHED, COMMAND, DETACHED, "200");

function read(...entries: readonly ProcessEntry[]): ProcessTableObservation {
  return { ok: true, source: "procfs", elapsedMs: 1, skipped: 0, table: new Map([host, ...entries].map((item) => [item.pid, item])) };
}
const failure = (reason: "timeout" | "read_failed" = "read_failed"): ProcessTableObservation => ({ ok: false, source: "procfs", elapsedMs: 1, reason });
const BASELINE = read(root, native, mcp, earlier);
const SNAPSHOT = read(root, native, mcp, earlier, command, detached);

function notify(fake: FakeLineProcess, method: string, params: JsonRecord): void {
  fake.emit(`${JSON.stringify({ method, params })}\n`);
}

interface Script {
  readonly interruptRefused?: boolean;
  /** How turn/interrupt ends the turn; null leaves it running. */
  readonly interruptEnds?: string | null;
}

function appServer(script: Script = {}): FakeLineProcess {
  let turns = 0;
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") { return; }
    if (message.method === "turn/interrupt" && script.interruptRefused === true) {
      process.emit(`${JSON.stringify({ id: message.id, error: { message: "turn already finished" } })}\n`);
      return;
    }
    let result: JsonRecord = {};
    if (message.method === "thread/start") { result = { thread: { id: threadId }, model: "gpt-5.5" }; }
    if (message.method === "turn/start") { turns += 1; result = { turn: { id: `turn-${String(turns)}` } }; }
    process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
    if (message.method === "turn/start") { notify(process, "turn/started", { threadId, turn: { id: `turn-${String(turns)}` } }); }
    if (message.method === "turn/interrupt" && script.interruptEnds !== null) {
      notify(process, "turn/completed", { threadId, turn: { id: asRecord(message.params)?.turnId, status: script.interruptEnds ?? "interrupted" } });
    }
  });
  Object.defineProperty(fake, "pid", { value: ROOT });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

function sentMethods(fake: FakeLineProcess): unknown[] {
  return fake.written.map((text) => asRecord(JSON.parse(text))?.method);
}

/** A staged observation holding `observation`, with spies on its two steps. */
function staged(observation?: ProcessTableObservation): CancellationObservation & { commit: Mock<() => void>; complete: Mock<() => void> } {
  return { ...(observation === undefined ? {} : { observation }), commit: vi.fn<() => void>(), complete: vi.fn<() => void>() };
}

/** Each read in order: the baseline, then the revalidation after the turn. */
function scriptReads(...results: readonly (ProcessTableObservation | Promise<ProcessTableObservation>)[]): MockInstance<typeof budget.observeProcessTableWithin> {
  const queue = [...results];
  return vi.spyOn(budget, "observeProcessTableWithin").mockImplementation(async () => {
    const next = queue.shift();
    if (next === undefined) { throw new Error("an unexpected process table read"); }
    const result = await next;
    return result;
  });
}

async function cleanupOf(session: Session): Promise<unknown> {
  return vi.waitFor(() => {
    const record = session.records().find((candidate) => candidate.kind === "response" && candidate.body.kind === "cleanup");
    if (record?.kind !== "response" || record.body.kind !== "cleanup") { throw new Error("no cleanup response yet"); }
    return { requestId: record.requestId, result: record.body.result };
  });
}

async function promptedSession(fake: FakeLineProcess): Promise<Session> {
  const session = await codexSession(installation, { cwd: process.cwd(), endTurnProcessesOnAbort: true });
  const prompt = await session.prompt("run");
  expect(prompt.response.body.kind).toBe("accepted");
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("running"); });
  expect(sentMethods(fake)).toContain("turn/start");
  return session;
}

let kill: MockInstance<typeof process.kill>;
beforeEach(() => {
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  spawnLineProcess.mockReset();
});

function signalled(): number[] { return kill.mock.calls.map((call) => call[0]).toSorted((left, right) => left - right); }
const ascending = (values: readonly number[]): number[] => values.toSorted((left, right) => left - right);

test("after an interrupted turn, ends snapshot minus baseline with their groups and nothing else; the session stays usable", async () => {
  const fake = appServer();
  scriptReads(BASELINE, SNAPSHOT);
  const stage = staged(SNAPSHOT);
  const observe = vi.spyOn(fake, "observeCancellation").mockImplementation(async () => {
    // The snapshot is taken before the interrupt goes out.
    expect(sentMethods(fake)).not.toContain("turn/interrupt");
    expect(kill).not.toHaveBeenCalled();
    return stage;
  });
  const session = await promptedSession(fake);
  const abort = await session.abort();
  expect(abort.response.body.kind).toBe("accepted");
  expect(observe).toHaveBeenCalledOnce();
  expect(stage.commit).toHaveBeenCalledOnce();
  expect(await cleanupOf(session)).toEqual({ requestId: abort.request.id, result: { kind: "completed", signalled: 2 } });
  expect(stage.complete).toHaveBeenCalled();
  expect(signalled()).toEqual(ascending([-COMMAND, -DETACHED, COMMAND, DETACHED]));
  expect(fake.killed()).toBe(false);
  // The turn's end frame precedes what OAR did about it, and no frame is invented for it.
  const kinds = session.records().flatMap((record) => record.kind === "frame" ? [record.body.type] : (record.kind === "response" && record.body.kind === "cleanup" ? ["cleanup"] : []));
  expect(kinds.indexOf("turn/completed")).toBeLessThan(kinds.indexOf("cleanup"));
  scriptReads(BASELINE);
  const next = await session.prompt("again");
  expect(next.response.body).toMatchObject({ kind: "accepted", native: { turn: { id: "turn-2" } } });
});

test("a pid reused since the baseline counts as new, and an unchanged one as earlier", async () => {
  const reused = { ...earlier, start: "300" };
  const fake = appServer();
  scriptReads(BASELINE, read(root, native, mcp, reused));
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(read(root, native, mcp, reused)));
  const session = await promptedSession(fake);
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "completed", signalled: 1 } });
  expect(signalled()).toContain(EARLIER);
  expect(signalled()).not.toContain(MCP);
});

test("the baseline read failing ends nothing and says so", async () => {
  const fake = appServer();
  scriptReads(failure());
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await promptedSession(fake);
  const abort = await session.abort();
  expect(abort.response.body.kind).toBe("accepted");
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "the baseline process table read failed: read_failed" } });
  expect(kill).not.toHaveBeenCalled();
});

test("a baseline read still running does not hold turn/start, and at the snapshot it ends nothing", async () => {
  const fake = appServer();
  const pending = Promise.withResolvers<ProcessTableObservation>();
  scriptReads(pending.promise);
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await promptedSession(fake);
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "the baseline process table read had not finished" } });
  // Its late answer is not evidence for an abort already decided.
  pending.resolve(BASELINE);
  await Promise.resolve();
  expect(kill).not.toHaveBeenCalled();
});

test.each([
  ["a failed snapshot", staged(failure()), "the pre-interrupt snapshot process table read failed: read_failed"],
  ["a snapshot past its deadline", staged(failure("timeout")), "the pre-interrupt snapshot process table read failed: timeout"],
  ["no snapshot at all", staged(), "no snapshot of the app-server's processes could be taken"],
])("%s still interrupts and ends nothing", async (_name, stage, reason) => {
  const fake = appServer();
  scriptReads(BASELINE);
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(stage);
  const session = await promptedSession(fake);
  const abort = await session.abort();
  expect(abort.response.body.kind).toBe("accepted");
  expect(sentMethods(fake)).toContain("turn/interrupt");
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason } });
  expect(kill).not.toHaveBeenCalled();
});

test("an observation that throws still interrupts and ends nothing", async () => {
  const fake = appServer();
  scriptReads(BASELINE);
  vi.spyOn(fake, "observeCancellation").mockRejectedValue(new Error("no table"));
  const session = await promptedSession(fake);
  expect((await session.abort()).response.body.kind).toBe("accepted");
  expect(sentMethods(fake)).toContain("turn/interrupt");
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed" } });
  expect(kill).not.toHaveBeenCalled();
});

test("an app-server that is not the same process in both reads ends nothing", async () => {
  const fake = appServer();
  scriptReads(read({ ...root, start: "1" }, native, mcp, earlier));
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await promptedSession(fake);
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "the app-server is not the same process in both reads" } });
  expect(kill).not.toHaveBeenCalled();
});

test("an abort the runtime refused ends nothing and withdraws its claim", async () => {
  const fake = appServer({ interruptRefused: true });
  scriptReads(BASELINE);
  const first = staged(SNAPSHOT);
  const observe = vi.spyOn(fake, "observeCancellation").mockResolvedValue(first);
  const session = await promptedSession(fake);
  const abort = await session.abort();
  expect(abort.response.body).toMatchObject({ kind: "rejected", code: "runtime_refused" });
  expect(first.commit).toHaveBeenCalledOnce();
  expect(first.complete).toHaveBeenCalledOnce();
  // The turn ends some other way: nothing here asked for it, so nothing is ended.
  notify(fake, "turn/completed", { threadId, turn: { id: "turn-1", status: "interrupted" } });
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
  expect(session.records().some((record) => record.kind === "response" && record.body.kind === "cleanup")).toBe(false);
  expect(kill).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledOnce();
});

test("a refused abort does not hold the next abort of the same turn to its snapshot", async () => {
  let refuse = true;
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number") { return; }
    if (message.method === "turn/interrupt" && refuse) { refuse = false; process.emit(`${JSON.stringify({ id: message.id, error: { message: "not yet" } })}\n`); return; }
    const result = message.method === "thread/start" ? { thread: { id: threadId }, model: "gpt-5.5" } : (message.method === "turn/start" ? { turn: { id: "turn-1" } } : {});
    process.emit(`${JSON.stringify({ id: message.id, result })}\n`);
    if (message.method === "turn/interrupt") { notify(process, "turn/completed", { threadId, turn: { id: "turn-1", status: "interrupted" } }); }
  });
  Object.defineProperty(fake, "pid", { value: ROOT });
  spawnLineProcess.mockReturnValue(fake);
  scriptReads(BASELINE, SNAPSHOT);
  const first = staged(BASELINE);
  const second = staged(SNAPSHOT);
  const observe = vi.spyOn(fake, "observeCancellation").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const session = await promptedSession(fake);
  expect((await session.abort()).response.body.kind).toBe("rejected");
  const accepted = await session.abort();
  expect(accepted.response.body.kind).toBe("accepted");
  expect(observe).toHaveBeenCalledTimes(2);
  expect(await cleanupOf(session)).toEqual({ requestId: accepted.request.id, result: { kind: "completed", signalled: 2 } });
});

test("a turn that ends while the snapshot is being taken gets no interrupt and ends nothing", async () => {
  const fake = appServer();
  scriptReads(BASELINE);
  const gate = Promise.withResolvers<CancellationObservation>();
  const stage = staged(SNAPSHOT);
  vi.spyOn(fake, "observeCancellation").mockReturnValue(gate.promise);
  const session = await promptedSession(fake);
  const abort = session.abort();
  await vi.waitFor(() => { expect(fake.observeCancellation).toHaveBeenCalled(); });
  notify(fake, "turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
  gate.resolve(stage);
  expect((await abort).response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
  expect(sentMethods(fake)).not.toContain("turn/interrupt");
  expect(stage.commit).not.toHaveBeenCalled();
  expect(stage.complete).toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
});

test("an interrupt that loses the race to a natural end ends nothing: a completed turn keeps its work", async () => {
  const fake = appServer({ interruptEnds: "completed" });
  scriptReads(BASELINE);
  const stage = staged(SNAPSHOT);
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(stage);
  const session = await promptedSession(fake);
  expect((await session.abort()).response.body.kind).toBe("accepted");
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "the turn ended with status completed, not by this interrupt" } });
  expect(stage.complete).toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
});

test("identity mismatch at revalidation: a pid now held by another process is never signalled", async () => {
  const fake = appServer();
  scriptReads(BASELINE, read(root, native, mcp, earlier, { ...command, start: "999" }, detached));
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await promptedSession(fake);
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "completed", signalled: 1 } });
  expect(signalled()).toEqual(ascending([-DETACHED, DETACHED]));
});

test("a revalidation read that fails signals nothing and says so", async () => {
  const fake = appServer();
  scriptReads(BASELINE, failure("timeout"));
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await promptedSession(fake);
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "the revalidating process table read failed: timeout" } });
  expect(kill).not.toHaveBeenCalled();
});

test("a difference with nothing in it needs no further read and records zero", async () => {
  const fake = appServer();
  scriptReads(BASELINE);
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(BASELINE));
  const session = await promptedSession(fake);
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "completed", signalled: 0 } });
  expect(kill).not.toHaveBeenCalled();
});

test("a turn OAR did not prompt has no baseline and ends nothing", async () => {
  const fake = appServer();
  const reads = scriptReads();
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await codexSession(installation, { cwd: process.cwd(), endTurnProcessesOnAbort: true });
  notify(fake, "turn/started", { threadId, turn: { id: "turn-1" } });
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("running"); });
  expect((await session.abort()).response.body.kind).toBe("accepted");
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "no baseline: OAR did not start this turn with a prompt" } });
  expect(reads).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
});

test("a refused prompt's baseline is not left for a later turn OAR did not prompt", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number") { return; }
    if (message.method === "turn/start") { process.emit(`${JSON.stringify({ id: message.id, error: { message: "no" } })}\n`); return; }
    process.emit(`${JSON.stringify({ id: message.id, result: message.method === "thread/start" ? { thread: { id: threadId }, model: "gpt-5.5" } : {} })}\n`);
    if (message.method === "turn/interrupt") { notify(process, "turn/completed", { threadId, turn: { id: "turn-9", status: "interrupted" } }); }
  });
  Object.defineProperty(fake, "pid", { value: ROOT });
  spawnLineProcess.mockReturnValue(fake);
  scriptReads(BASELINE);
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(staged(SNAPSHOT));
  const session = await codexSession(installation, { cwd: process.cwd(), endTurnProcessesOnAbort: true });
  expect((await session.prompt("run")).response.body.kind).toBe("rejected");
  notify(fake, "turn/started", { threadId, turn: { id: "turn-9" } });
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("running"); });
  await session.abort();
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed", reason: "no baseline: OAR did not start this turn with a prompt" } });
  expect(kill).not.toHaveBeenCalled();
});

test("an exit before the aborted turn ends is recorded, ahead of the exit, and ends nothing here", async () => {
  const fake = appServer({ interruptEnds: null });
  scriptReads(BASELINE);
  const stage = staged(SNAPSHOT);
  vi.spyOn(fake, "observeCancellation").mockResolvedValue(stage);
  const session = await promptedSession(fake);
  expect((await session.abort()).response.body.kind).toBe("accepted");
  fake.end(1);
  expect(await cleanupOf(session)).toMatchObject({ result: { kind: "failed" } });
  expect(stage.complete).toHaveBeenCalled();
  const kinds = session.records().flatMap((record) => record.kind === "response" ? [record.body.kind] : []);
  expect(kinds.indexOf("cleanup")).toBeLessThan(kinds.indexOf("exited"));
  expect(kill).not.toHaveBeenCalled();
});

test("a dispose during the snapshot sends no interrupt", async () => {
  const fake = appServer();
  scriptReads(BASELINE);
  const gate = Promise.withResolvers<CancellationObservation>();
  const stage = staged(SNAPSHOT);
  vi.spyOn(fake, "observeCancellation").mockReturnValue(gate.promise);
  const session = await promptedSession(fake);
  const abort = session.abort();
  await vi.waitFor(() => { expect(fake.observeCancellation).toHaveBeenCalled(); });
  await session.dispose();
  gate.resolve(stage);
  expect((await abort).response.body).toMatchObject({ kind: "rejected" });
  expect(sentMethods(fake)).not.toContain("turn/interrupt");
  expect(stage.commit).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
});

test("repeated aborts share one snapshot, and the first accepted request carries the cleanup", async () => {
  const fake = appServer();
  scriptReads(BASELINE, SNAPSHOT);
  const gate = Promise.withResolvers<CancellationObservation>();
  const stage = staged(SNAPSHOT);
  const observe = vi.spyOn(fake, "observeCancellation").mockReturnValue(gate.promise);
  const session = await promptedSession(fake);
  const aborts = [session.abort(), session.abort()];
  await vi.waitFor(() => { expect(observe).toHaveBeenCalled(); });
  gate.resolve(stage);
  const [first] = await Promise.all(aborts);
  expect(observe).toHaveBeenCalledOnce();
  expect(await cleanupOf(session)).toMatchObject({ requestId: first?.request.id, result: { kind: "completed" } });
  expect(session.records().filter((record) => record.kind === "response" && record.body.kind === "cleanup")).toHaveLength(1);
});

test("without the option nothing is read, abort writes at once, and no cleanup is recorded", async () => {
  const fake = appServer();
  const reads = scriptReads();
  const observe = vi.spyOn(fake, "observeCancellation");
  const session = await codexSession(installation, { cwd: process.cwd(), endTurnProcessesOnAbort: false });
  await session.prompt("run");
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("running"); });
  const abort = session.abort();
  expect(sentMethods(fake)).toContain("turn/interrupt");
  await abort;
  await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
  expect(reads).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(session.records().some((record) => record.kind === "response" && record.body.kind === "cleanup")).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

test("shared placement refuses the option before anything starts", async () => {
  const shared = defineRuntime({ id: "codex-shared-probe", session: codexSession }, { execution: "process", shared: { refusal: () => null, session: () => codexSession } });
  await expect(shared.withPlacement("shared").session(installation, { cwd: "/tmp", endTurnProcessesOnAbort: true })).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(shared.withPlacement("shared").session(installation, { cwd: "/tmp", endTurnProcessesOnAbort: true })).rejects.toMatchObject({ option: "endTurnProcessesOnAbort" });
  await expect(codexRuntime.withPlacement("shared").session(installation, { cwd: "/tmp", endTurnProcessesOnAbort: true })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("a client queued behind a fresh home's first open reports no process until it has one", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "oar-turn-processes-home-"));
  try {
    let pid = ROOT;
    spawnLineProcess.mockImplementation(() => {
      const fake = fakeLineProcess((text, process) => {
        const message = asRecord(JSON.parse(text));
        if (typeof message?.id === "number") { process.emit(`${JSON.stringify({ id: message.id, result: {} })}\n`); }
      });
      Object.defineProperty(fake, "pid", { value: pid });
      pid += 1;
      return fake;
    });
    const first = startAppServerClient("codex", { CODEX_HOME: home }, {}, home);
    const queued = startAppServerClient("codex", { CODEX_HOME: home }, {}, home);
    expect(first.rootPid()).toBe(ROOT);
    expect(queued.rootPid()).toBeUndefined();
    expect((await queued.observeCancellation()).observation).toBeUndefined();
    await first.request("initialize", {});
    first.notify("initialized", {});
    expect(queued.rootPid()).toBe(ROOT + 1);
    first.kill();
    queued.kill();
  } finally { await rm(home, { recursive: true, force: true }); }
});

function reading(...entries: readonly ProcessEntry[]): ProcessTableReading {
  return { table: new Map([host, ...entries].map((item) => [item.pid, item])), source: "procfs" };
}

test("the app-server's own group is its work, not the turn's: a helper there is not a target", () => {
  const helper = entry(910_010, NATIVE, ROOT, "200");
  const baseline = reading(root, native).table;
  expect(turnEntries(ROOT, baseline, reading(root, native, helper, command)).map((item) => item.pid)).toEqual([COMMAND]);
});

test("a group holding anything but targets is not signalled: the app-server's, or one an earlier process shares", () => {
  const sharing = entry(910_011, NATIVE, MCP, "200");
  const targets = [sharing, command];
  const fresh = reading(root, native, mcp, sharing, command);
  expect(endTurnEntries(ROOT, targets, reading(root, native, mcp).table, fresh)).toBe(2);
  expect(signalled()).toEqual(ascending([sharing.pid, COMMAND, -COMMAND]));
});

test("a process a target started since the snapshot is ended too, and the app-server and the host never are", () => {
  const late = entry(910_012, DETACHED, DETACHED, "300");
  const self = entry(process.pid, DETACHED, HOST_GROUP);
  const fresh = reading(root, native, detached, late);
  expect(endTurnEntries(ROOT, [detached, { ...root, ppid: DETACHED }, self], reading(root, native).table, fresh)).toBe(2);
  expect(signalled()).toEqual(expect.arrayContaining([DETACHED, late.pid]));
  expect(signalled()).not.toContain(ROOT);
  expect(signalled()).not.toContain(process.pid);
});

test.skipIf(process.platform === "win32")("against the real table: only the process started after the baseline is killed", async () => {
  kill.mockRestore();
  const older = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const hostRoot = process.pid;
  try {
    const baseline = observeProcessTable();
    if (!baseline.ok) { throw new Error("no process table"); }
    const newer = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      await vi.waitFor(() => { expect(observeProcessTable()).toMatchObject({ ok: true }); });
      const snapshot = observeProcessTable();
      if (!snapshot.ok) { throw new Error("no process table"); }
      // This host stands in for the root: its children are what the tree holds.
      const targets = turnEntries(hostRoot, baseline.table, snapshot).filter((item) => item.pid === newer.pid);
      expect(targets.map((item) => item.pid)).toEqual([newer.pid]);
      expect(turnEntries(hostRoot, baseline.table, snapshot).map((item) => item.pid)).not.toContain(older.pid);
      const fresh = observeProcessTable();
      if (!fresh.ok) { throw new Error("no process table"); }
      expect(endTurnEntries(hostRoot, targets, baseline.table, fresh)).toBe(1);
      await vi.waitFor(() => { expect(newer.exitCode !== null || newer.signalCode !== null).toBe(true); });
      expect(newer.signalCode).toBe("SIGKILL");
      expect(older.exitCode === null && older.signalCode === null).toBe(true);
    } finally { newer.kill("SIGKILL"); }
  } finally { older.kill("SIGKILL"); }
});
