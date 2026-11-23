import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { grokSession } from "../../packages/oar/src/runtimes/grok/session.js";
import { kimiSession } from "../../packages/oar/src/runtimes/kimi/session.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "runtime" } as const;
const SERVED_MCP_SERVER = { name: "host", type: "http", url: "http://127.0.0.1/mcp", origin: "serveMcpTools" } as const;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); spawnLineProcess.mockReset(); });

async function outcome(operation: Promise<unknown>): Promise<unknown> {
  try { return await operation; } catch (error) { return error; }
}

function resultFor(heldMethod: string | null, authMethodId: string, method: string): JsonRecord {
  if (method === "initialize") {
    return {
      protocolVersion: 1,
      authMethods: [{ id: authMethodId, name: authMethodId }],
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, sessionCapabilities: { list: {}, ...(heldMethod === "session/load" ? {} : { resume: {} }) } },
    };
  }
  if (method === "session/list") { return { sessions: [{ sessionId: "saved", cwd: "/work" }] }; }
  return {
    sessionId: "saved",
    configOptions: [
      { id: "mode", name: "Mode", type: "select", category: "mode", currentValue: "normal", options: [{ value: "yolo", name: "YOLO" }] },
      { id: "thinking", name: "Thinking", type: "select", category: "thought_level", currentValue: "low", options: [{ value: "low", name: "Low" }] },
    ],
  };
}

function emitAnswer(
  child: FakeLineProcess,
  context: { readonly heldMethod: string | null; readonly authMethodId: string },
  request: JsonRecord,
): void {
  const result = resultFor(context.heldMethod, context.authMethodId, String(request.method));
  child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

interface SetupOptions {
  readonly startSession?: typeof kimiSession;
  readonly heldMethod: string | null;
  readonly authMethodId?: string;
  readonly options?: Partial<SessionOptions>;
}

function setup({ startSession = kimiSession, heldMethod, authMethodId = "login", options }: SetupOptions) {
  const child = fakeLineProcess();
  const calls: string[] = [];
  let held: JsonRecord = {};
  const resume = options?.resume !== undefined || (heldMethod !== null && ["session/resume", "session/load", "session/list"].includes(heldMethod));
  const answer = (request: JsonRecord): void => { emitAnswer(child, { heldMethod, authMethodId }, request); };
  const notify = (method: string, params: JsonRecord): void => { child.emit(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); };
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = asRecord(JSON.parse(line));
      if (request?.id !== undefined) {
        const method = String(request.method);
        calls.push(method);
        if (method === heldMethod) { held = request; }
        else { answer(request); }
      }
    }
  });
  spawnLineProcess.mockReturnValue(child);
  const result = outcome(startSession(installation, {
    cwd: "/work",
    ...(resume ? { resume: "saved" } : {}),
    ...(heldMethod === "session/set_model" ? { model: "model" } : {}),
    ...(heldMethod === "session/set_config_option" ? { effort: "low" } : {}),
    ...options,
  }));
  return { child, calls, result, notify, answer: () => { answer(held); } };
}

async function expectAdmitsSlowOpen(config: SetupOptions, waitMs: number, expectedMethod: string) {
  const run = setup(config);
  await vi.advanceTimersByTimeAsync(0);
  expect(run.calls.at(-1)).toBe(expectedMethod);
  await vi.advanceTimersByTimeAsync(waitMs);
  expect(run.child.killed()).toBe(false);
  run.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(await run.result).toHaveProperty("id", "saved");
  run.child.kill();
  expect(vi.getTimerCount()).toBe(0);
}

async function expectTimeoutAt(config: SetupOptions, timeoutMs: number, expectedMethod: string) {
  const run = setup(config);
  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toMatchObject({ kind: "timeout", method: expectedMethod, timeoutMs });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
}

test.each(["session/new", "session/resume"])("Kimi %s admits a silent hook longer than 30 seconds", async (method) => {
  await expectAdmitsSlowOpen({ heldMethod: method }, 60_000, method);
});

test.each(["session/new", "session/resume"])("Kimi %s still fails at 630 seconds and cleans up", async (method) => {
  await expectTimeoutAt({ heldMethod: method }, 630_000, method);
});

test.each(["authenticate", "session/list", "session/set_model", "session/set_config_option", "session/set_mode"])("Kimi %s retains its 30-second bound", async (method) => {
  const run = setup({ heldMethod: method });
  await vi.advanceTimersByTimeAsync(0);
  expect(run.calls.at(-1)).toBe(method);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toBeInstanceOf(Error);
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("Kimi session/load admits over 30 seconds", async () => {
  await expectAdmitsSlowOpen({ heldMethod: "session/load" }, 45_000, "session/load");
});

test("Kimi session/load fails at 60 seconds rather than 30 or 630 seconds", async () => {
  await expectTimeoutAt({ heldMethod: "session/load" }, 60_000, "session/load");
});

test("Grok session/load admits 40 seconds", async () => {
  await expectAdmitsSlowOpen({ startSession: grokSession, heldMethod: "session/load", authMethodId: "cached_token" }, 40_000, "session/load");
});

test("Grok session/load fails at 60 seconds with cleanup", async () => {
  await expectTimeoutAt({ startSession: grokSession, heldMethod: "session/load", authMethodId: "cached_token" }, 60_000, "session/load");
});

test("Grok served-MCP readiness succeeds within session/load's 60-second budget", async () => {
  const ready = setup({ startSession: grokSession, heldMethod: "session/load", authMethodId: "cached_token", options: { mcpServers: [SERVED_MCP_SERVER] } });
  await vi.advanceTimersByTimeAsync(25_000);
  ready.answer();
  await vi.advanceTimersByTimeAsync(5000);
  expect(ready.child.killed()).toBe(false);
  ready.notify("_x.ai/mcp_initialized", { sessionId: "saved", mcpToolCount: 1 });
  ready.notify("_x.ai/mcp/server_status", { sessionId: "saved", name: "host", status: "ready" });
  expect(await ready.result).toHaveProperty("id", "saved");
  ready.child.kill();
  expect(vi.getTimerCount()).toBe(0);
});

test("Grok stalled served-MCP readiness fails at 60 seconds total after session/load", async () => {
  const stalled = setup({ startSession: grokSession, heldMethod: "session/load", authMethodId: "cached_token", options: { mcpServers: [SERVED_MCP_SERVER] } });
  await vi.advanceTimersByTimeAsync(25_000);
  stalled.answer();
  await vi.advanceTimersByTimeAsync(34_999);
  expect(stalled.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await stalled.result).toMatchObject({ kind: "timeout", method: "_x.ai/mcp_initialized", timeoutMs: 60_000 });
  expect(stalled.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["session/new", "authenticate", "session/set_model"])("Grok %s retains its 30-second bound", async (method) => {
  await expectTimeoutAt({ startSession: grokSession, heldMethod: method, authMethodId: "cached_token" }, 30_000, method);
});

const customProfile: AcpSessionProfile = {
  args: ["acp"],
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  selectAuthMethod: () => "login",
  sessionLoadTimeoutMs: 45_000,
};

test("sessionLoadTimeoutMs overrides session/load without changing ordinary requests", async () => {
  await expectTimeoutAt({ startSession: acpSession(customProfile), heldMethod: "session/load" }, 45_000, "session/load");
});

test.each(["session/new", "authenticate"])("sessionLoadTimeoutMs leaves %s at requestTimeoutMs", async (method) => {
  await expectTimeoutAt({ startSession: acpSession(customProfile), heldMethod: method }, 15_000, method);
});
