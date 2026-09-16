import { afterEach, expect, test, vi } from "vitest";
import { resolve } from "node:path";
import { codexSkills, codexTools, codexMcpServers } from "../packages/oar/src/runtimes/codex/inventory.js";
import { claudeSkills, claudeTools, claudeMcpServers } from "../packages/oar/src/runtimes/claude/inventory.js";
import { grokSkills, grokMcpServers } from "../packages/oar/src/runtimes/grok/inventory.js";
import { runtimes } from "../packages/oar/src/index.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "./fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(
  command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => FakeLineProcess>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const executable = { kind: "available", via: "executable", command: "fake" } as const;
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });

function rpc(serve: (method: string, params: Record<string, unknown>) => unknown): FakeLineProcess {
  return fakeLineProcess((text, self) => {
    const request = asRecord(parseJson(text));
    if (request?.id === undefined) { return; }
    const result = serve(String(request.method), asRecord(request.params) ?? {});
    self.emit(`${JSON.stringify({ id: request.id, result })  }\n`);
  });
}
function control(serve: (method: string) => unknown): FakeLineProcess {
  return fakeLineProcess((text, self) => {
    const request = asRecord(parseJson(text));
    const response = serve(String(asRecord(request?.request)?.subtype));
    // Unrelated response must not settle the current request.
    self.emit(`${JSON.stringify({ type: "control_response", response: { request_id: "other", subtype: "success", response: {} } })  }\n`);
    self.emit(`${JSON.stringify({ type: "control_response", response: { request_id: request?.request_id, subtype: "success", response } })  }\n`);
  });
}

test("Codex forwards resolved cwd and preserves disabled skills without creating a thread", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
  const calls: unknown[] = [];
  const fake = rpc((method, params) => {
    calls.push([method, params]);
    return method === "initialize" ? {} : { data: [{ skills: [
      { name: "review", enabled: false, path: "/skills/review", scope: "user", description: "Review" },
    ], errors: [{ message: "private error text" }] }] };
  });
  spawnLineProcess.mockReturnValue(fake);
  const result = await codexSkills(executable, { cwd: "./project-b" });
  expect(result).toEqual({
    kind: "ok", scope: { kind: "workspace", cwd: resolve("./project-b") },
    observedAt: "2026-09-16T00:00:00.000Z", view: "discovered", partial: true,
    items: [{ name: "review", enabled: false, path: "/skills/review", source: "user", description: "Review" }],
  });
  expect(calls).toEqual([
    ["initialize", { clientInfo: { name: "oar-inventory", version: "0.0.0" }, capabilities: { experimentalApi: true } }],
    ["skills/list", { cwds: [resolve("./project-b")] }],
  ]);
  expect(spawnLineProcess.mock.calls[0]?.[2]?.cwd).toBe(resolve("./project-b"));
  expect(fake.killed()).toBe(true);
});

test("Codex exhausts MCP pages and labels tools as MCP-only without exposing config", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
  const cursors: unknown[] = [];
  const fake = rpc((method, params) => {
    if (method === "initialize") { return {}; }
    cursors.push(params.cursor);
    return params.cursor === null
      ? { data: [{ name: "one", tools: { read: { name: "read", description: "Read", inputSchema: { type: "object" } } }, config: { token: "secret" } }], nextCursor: "next" }
      : { data: [{ name: "two", tools: {}, toolsError: "Authorization: secret" }], nextCursor: null };
  });
  spawnLineProcess.mockReturnValue(fake);
  const result = await codexTools(executable);
  expect(result).toEqual({
    kind: "ok", scope: { kind: "workspace", cwd: process.cwd() }, observedAt: "2026-09-16T00:00:00.000Z",
    view: "mcp-only", partial: true,
    items: [{ name: "read", description: "Read", mcpServerId: "one", source: "mcp", inputSchema: { type: "object" } }],
  });
  expect(cursors).toEqual([null, "next"]);
  expect(fake.killed()).toBe(true);
});

test.each(["repeat", "malformed"])("Codex %s pagination is failure, not empty success", async (mode) => {
  const fake = rpc((method) => {
    if (method === "initialize") { return {}; }
    return mode === "repeat" ? { data: [], nextCursor: "same" } : { data: "invalid", nextCursor: null };
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(codexMcpServers(executable)).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(fake.killed()).toBe(true);
});

test("unknown MCP status remains absent, not connected", async () => {
  spawnLineProcess.mockReturnValue(rpc((method) => method === "initialize" ? {} : {
    data: [{ name: "a", runtimeStatus: null, authStatus: "unsupported", tools: {} }], nextCursor: null,
  }));
  const result = await codexMcpServers(executable);
  expect(result).toMatchObject({ kind: "ok", items: [{ id: "a", name: "a", authStatus: "unsupported", toolCount: 0 }] });
  if (result.kind === "ok") { expect(result.items[0]).not.toHaveProperty("status"); }
});

test("Claude skills are context entries, never initialize command aliases", async () => {
  const fake = control((method) => method === "initialize"
    ? { commands: [{ name: "not-a-skill" }] }
    : { skills: { skillFrontmatter: [{ name: "actual-skill", source: "plugin", tokens: 30 }] } });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeSkills(executable, { cwd: "project-a" })).resolves.toMatchObject({
    kind: "ok", view: "context", items: [{ name: "actual-skill", source: "plugin" }],
  });
  expect(spawnLineProcess.mock.calls[0]?.[2]?.cwd).toBe(resolve("project-a"));
  expect(fake.written.map((text) => asRecord(parseJson(text))?.type)).toEqual(["control_request", "control_request"]);
  expect(fake.killed()).toBe(true);
});

test("Claude pending MCP waits for startup; failure remains partial and strips native error secrets", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const fake = control((method) => {
    if (method === "initialize") { return {}; }
    reads += 1;
    return { mcpServers: reads === 1 ? [{ name: "a", status: "pending" }] : [
      { name: "a", status: "connected", tools: [{ name: "read", annotations: {} }] },
      { name: "b", status: "failed", error: "token=secret" },
    ] };
  });
  spawnLineProcess.mockReturnValue(fake);
  const reading = claudeTools(executable);
  await vi.advanceTimersByTimeAsync(200);
  await expect(reading).resolves.toMatchObject({
    kind: "ok", view: "mcp-only", partial: true,
    items: [{ name: "read", mcpServerId: "a", source: "mcp" }],
  });
  expect(reads).toBe(2);
  expect(fake.killed()).toBe(true);
});

test("Claude native unsupported is distinct from query failure", async () => {
  const fake = fakeLineProcess((text, self) => {
    const request = asRecord(parseJson(text));
    const init = asRecord(request?.request)?.subtype === "initialize";
    self.emit(`${JSON.stringify({ type: "control_response", response: {
      request_id: request?.request_id, subtype: init ? "success" : "error",
      ...(init ? { response: {} } : { error: "Unsupported control request subtype" }),
    } })  }\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeMcpServers(executable)).resolves.toMatchObject({ kind: "unsupported", code: "native_query_unavailable" });
  expect(fake.killed()).toBe(true);
});

test.each([codexSkills, claudeSkills, grokSkills])("timeout releases owned discovery process", async (read) => {
  vi.useFakeTimers();
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const result = read(executable, { timeoutMs: 30 });
  await vi.advanceTimersByTimeAsync(30);
  await expect(result).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(fake.killed()).toBe(true);
});

test.each([claudeSkills, grokMcpServers])("malformed native list never becomes an empty success", async (read) => {
  const fake = read === claudeSkills ? control(() => ({})) : fakeLineProcess();
  spawnLineProcess.mockImplementation(() => {
    queueMicrotask(() => { if (read === grokMcpServers) { fake.emit("{}"); fake.end(0); } });
    return fake;
  });
  await expect(read(executable)).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
});

test("Grok independent discovery never authenticates or creates a session", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockImplementation(() => {
    queueMicrotask(() => {
      fake.emit(JSON.stringify({ mcpServers: [{ name: "compat", source: "project", command: "secret", target: "secret" }] }));
      fake.end(0);
    });
    return fake;
  });
  await expect(grokMcpServers(executable)).resolves.toMatchObject({
    kind: "ok", view: "discovered", items: [{ id: "compat", name: "compat", source: "project" }],
  });
  expect(spawnLineProcess.mock.calls[0]?.[1]).toEqual(["inspect", "--json"]);
  expect(fake.written).toEqual([]);
});

test("unavailable native surfaces return unsupported without starting a runtime", async () => {
  await expect(runtimes.require("kimi").skills(executable)).resolves.toMatchObject({ kind: "unsupported" });
  await expect(runtimes.require("grok").tools(executable)).resolves.toMatchObject({ kind: "unsupported" });
  await expect(runtimes.require("pi").mcpServers({ kind: "available", via: "bundled" })).resolves.toMatchObject({ kind: "unsupported" });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
