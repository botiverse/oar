/* oxlint-disable eslint/max-statements, import/max-dependencies -- Observe native requests, retained frames and folds across each complete isolated session. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { contextUsageOf } from "../../packages/oar/src/observe/usage.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

const sessions: Session[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map(async session => { await session.dispose(); }));
  await Promise.all(directories.splice(0).map(async directory => { await rm(directory, { recursive: true, force: true }); }));
});
async function open() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oar-acp-records-")); directories.push(cwd);
  const session = await acpSession({ args: [fileURLToPath(new URL("../fixtures/fake-acp-shared.mjs", import.meta.url))], capabilities: { queue: { durable: false }, attribution: "nested" }, extensionNotifications: ["fixture/lineage", "fixture/usage"] })({ kind: "available", via: "executable", command: process.execPath }, { cwd });
  sessions.push(session); return { session, cwd };
}

test("isolated ACP retains extra fields and omitted defaults without changing projection or folds", async () => {
  const { session } = await open();
  expect(await promptAndWait(session, "raw-update")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  const tool = session.records().find(record => record.kind === "frame" && record.body.type === "tool_call");
  expect(tool?.kind === "frame" && tool.body.native).toEqual({ sessionId: session.id, vendorOuter: "kept", update: { sessionUpdate: "tool_call", toolCallId: "raw-tool", title: "Read", vendorTool: 42 } });
  expect(tool?.kind === "frame" && tool.body.events).toEqual([{ kind: "tool_call_started", callId: "raw-tool", tool: "Read" }]);
  const endings = session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "tool_call_ended") : []);
  expect(endings).toEqual([{ kind: "tool_call_ended", callId: "raw-tool", result: "ok" }]);
  expect(session.contextUsage().value).toEqual({ tokens: 250, contextWindow: 1000, percent: 25 });
  expect(contextUsageOf(session.records(), session.id)).toEqual(session.contextUsage());
});

test("isolated child permission and terminal request/answer pairs retain their child session id", async () => {
  const { session } = await open(); await promptAndWait(session, "child");
  const child = `${session.id}-child`;
  const requests = session.records().filter(record => record.kind === "request" && record.direction === "toApp");
  expect(requests.map(record => record.kind === "request" && record.body.kind === "native" ? record.body.type : "")).toEqual(["session/request_permission", "terminal/create", "terminal/release"]);
  for (const request of requests) {
    expect(request.sessionId).toBe(child);
    expect(session.records().find(record => record.kind === "response" && request.kind === "request" && record.requestId === request.id)?.sessionId).toBe(child);
  }
});

test("a native host request cancelled before dispatch is retained and answered without executing", async () => {
  const clients = await import("../../packages/oar/src/shared/acp/client-app.js");
  const cancelled = Promise.withResolvers<void>();
  // Hold dispatch until the SDK has processed the cancellation and the next
  // native notification. Separate pipe writes alone do not establish this order.
  vi.spyOn(clients, "createAcpClientApp").mockImplementation((terminal, hooks) => clients.createRoutedAcpClientApp({
    target: async () => { await cancelled.promise; return { terminal, hooks }; },
    update: hooks.update,
    extension: (method, params) => { if (method === "fixture/cancel-observed") { cancelled.resolve(); } else { hooks.extension(method, params); } },
    extensionNotifications: [...hooks.extensionNotifications, "fixture/cancel-observed"],
  }));
  const { session, cwd } = await open(); await promptAndWait(session, "cancelled-host");
  const request = session.records().find(record => record.kind === "request" && record.direction === "toApp");
  expect(request).toMatchObject({ kind: "request", body: { kind: "native", type: "terminal/create" } });
  const reply = session.records().find(record => record.kind === "response" && request?.kind === "request" && record.requestId === request.id);
  expect(reply).toMatchObject({ body: { kind: "answered" } });
  expect(reply?.kind === "response" && reply.body.kind === "answered" && typeof asRecord(reply.body.native)?.error).toBe("string");
  await expect(readFile(path.join(cwd, "cancelled-host-started"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("isolated native exit retains an explicit terminal cleanup failure response", async () => {
  const terminals = await import("../../packages/oar/src/shared/acp/terminal.js");
  const create = terminals.createAcpTerminalHost;
  vi.spyOn(terminals, "createAcpTerminalHost").mockImplementation((...args) => ({ ...create(...args), dispose: async () => { throw new Error("terminal cleanup refused"); } }));
  const { session } = await open(); await promptAndWait(session, "exit");
  // Terminal cleanup reporting follows the native process's asynchronous cleanup.
  try {
    await expect.poll(() => session.records().filter(record => record.kind === "response" && record.body.kind === "cleanup"), { timeout: 15_000 }).toMatchObject([{ requestId: "", body: { kind: "cleanup", result: { kind: "failed", reason: "terminal cleanup refused" } } }]);
  } catch (error) { throw new Error(`Missing terminal cleanup record: ${JSON.stringify(session.records())}`, { cause: error }); }
  expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1);
});
