import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { kimiSession } from "../../packages/oar/src/runtimes/kimi/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "kimi" } as const;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); spawnLineProcess.mockReset(); });

async function outcome(operation: Promise<unknown>): Promise<unknown> {
  try { return await operation; } catch (error) { return error; }
}

function setup(heldMethod: string) {
  const child = fakeLineProcess();
  const calls: string[] = [];
  let held: JsonRecord = {};
  const resume = ["session/resume", "session/load", "session/list"].includes(heldMethod);
  const resultFor = (method: string): JsonRecord => {
    if (method === "initialize") {
      return {
        protocolVersion: 1, authMethods: [{ id: "login", name: "Login" }],
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, ...(heldMethod === "session/load" ? {} : { resume: {} }) } },
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
  };
  const answer = (request: JsonRecord): void => {
    const result = resultFor(String(request.method));
    child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  };
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
  const result = outcome(kimiSession(installation, {
    cwd: "/work", ...(resume ? { resume: "saved" } : {}),
    ...(heldMethod === "session/set_model" ? { model: "model" } : {}),
    ...(heldMethod === "session/set_config_option" ? { effort: "low" } : {}),
  }));
  return { child, calls, result, answer: () => { answer(held); } };
}

test.each(["session/new", "session/resume"])("Kimi %s admits a silent hook longer than 30 seconds", async (method) => {
  const run = setup(method);
  await vi.advanceTimersByTimeAsync(0);
  expect(run.calls.at(-1)).toBe(method);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run.child.killed()).toBe(false);
  run.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(await run.result).toHaveProperty("id", "saved");
  run.child.kill();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["session/new", "session/resume"])("Kimi %s still fails at 630 seconds and cleans up", async (method) => {
  const run = setup(method);
  await vi.advanceTimersByTimeAsync(629_999);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toMatchObject({ kind: "timeout", method, timeoutMs: 630_000 });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["initialize", "authenticate", "session/list", "session/load", "session/set_model", "session/set_config_option", "session/set_mode"])("Kimi %s retains its 30-second bound", async (method) => {
  const run = setup(method);
  await vi.advanceTimersByTimeAsync(0);
  expect(run.calls.at(-1)).toBe(method);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toBeInstanceOf(Error);
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
