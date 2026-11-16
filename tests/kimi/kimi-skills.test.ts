import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({ ...await original<object>(), spawnLineProcess: spawn }));
const installation = { kind: "available", via: "executable", command: "kimi" } as const;
const token = "synthetic-private-startup-token";
const calls: { path: string; method: string; body: unknown }[] = [];
let fake: FakeLineProcess = fakeLineProcess();

function serve(skills: unknown = [{ name: "update-config", source: "builtin", path: "builtin://update-config", description: "Configure", disable_model_invocation: true, body: "private body" }]): void {
  fake = fakeLineProcess();
  spawn.mockImplementation(() => {
    queueMicrotask(() => { fake.emit(`http://127.0.0.1:45678/#token=${token}\n`); });
    return fake;
  });
  // oxlint-disable-next-line max-statements -- This fixture records and validates the complete HTTP exchange.
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    expect(new URL(input).origin).toBe("http://127.0.0.1:45678");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    const path = new URL(input).pathname;
    calls.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    let data: unknown = { id: "wm-owned" };
    if (path.endsWith("/skills")) { data = { skills }; }
    if (init?.method === "DELETE") { expect(new Headers(init.headers).has("content-type")).toBe(false); data = { deleted: true }; }
    return Response.json({ code: 0, data, msg: "success", request_id: "native" });
  }));
}

afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); spawn.mockReset(); });

test("Kimi discovers native metadata without a session and keeps its token private", async () => {
  serve();
  const result = await kimiRuntime.skills(installation, { cwd: "/project", env: readerEnvironment() });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: false, items: [
    { name: "update-config", source: "builtin", path: "builtin://update-config", description: "Configure", disableModelInvocation: true },
  ] });
  expect(calls).toEqual([
    { path: "/api/v1/workspaces", method: "POST", body: { root: resolve("/project") } },
    { path: "/api/v1/workspaces/wm-owned/skills", method: "GET", body: undefined },
    { path: "/api/v1/workspaces/wm-owned", method: "DELETE", body: undefined },
  ]);
  expect(spawn.mock.calls[0]?.[1]).toEqual(["web", "--no-open", "--host", "127.0.0.1", "--port", "0"]);
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ killTree: true, inheritStderr: false });
  expectReaderEnvironment(spawn.mock.calls[0]?.[2]?.env);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-private|private body/u);
  expect(fake.killed()).toBe(true);
});

test.each([undefined, {}, [{ description: "missing name" }]])("malformed skills are unavailable, not empty", async (payload) => {
  serve(payload ?? null);
  await expect(kimiRuntime.skills(installation)).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(fake.killed()).toBe(true);
  expect(calls.at(-1)?.method).toBe("DELETE");
});

test("empty native list succeeds", async () => {
  serve([]);
  await expect(kimiRuntime.skills(installation)).resolves.toMatchObject({ kind: "ok", items: [], partial: false });
});

// oxlint-disable-next-line max-statements -- The teardown timeline must retain each observation.
test("startup timeout waits for process teardown", async () => {
  vi.useFakeTimers();
  fake = fakeLineProcess();
  const kill = vi.spyOn(fake, "kill").mockImplementation(() => {});
  spawn.mockReturnValue(fake);
  let settled = false;
  const reading = (async () => { try { return await kimiRuntime.skills(installation, { timeoutMs: 25 }); } finally { settled = true; } })();
  await vi.advanceTimersByTimeAsync(25);
  expect(kill).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  fake.end(null);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
});

// oxlint-disable-next-line max-statements -- Observe the deadline, fetch signal, process and redacted result together.
test("query timeout aborts fetch, stops the owned process and does not expose errors", async () => {
  vi.useFakeTimers();
  serve();
  const requests: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) { throw new Error("Missing deadline"); }
    requests.push(signal);
    const { promise, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => { reject(new Error(token)); });
    return promise;
  }));
  const reading = kimiRuntime.skills(installation, { timeoutMs: 25 });
  await vi.advanceTimersByTimeAsync(25);
  const result = await reading;
  expect(result).toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(requests.every((signal) => signal.aborted)).toBe(true);
  expect(fake.killed()).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
});

test("untrusted startup URL never receives the bearer token", async () => {
  vi.useFakeTimers();
  fake = fakeLineProcess();
  spawn.mockImplementation(() => {
    queueMicrotask(() => { fake.emit(`http://example.invalid:45678/#token=${token}\n`); });
    return fake;
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const reading = kimiRuntime.skills(installation, { timeoutMs: 25 });
  await vi.advanceTimersByTimeAsync(25);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(fetch).not.toHaveBeenCalled();
});

test("nonzero native envelopes are unavailable", async () => {
  serve();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: 1001, data: null, msg: token })));
  const result = await kimiRuntime.skills(installation);
  expect(result).toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(fake.killed()).toBe(true);
});


test("native exit before readiness fails without sending HTTP requests", async () => {
  fake = fakeLineProcess();
  spawn.mockImplementation(() => {
    queueMicrotask(() => { fake.end(1); });
    return fake;
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(kimiRuntime.skills(installation)).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(fetch).not.toHaveBeenCalled();
  expect(fake.killed()).toBe(true);
});
