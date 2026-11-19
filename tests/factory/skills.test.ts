import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { factoryRuntime } from "../../packages/oar/src/runtimes/factory/index.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({ ...await original<object>(), spawnLineProcess: spawn }));
const installation = { kind: "available", via: "executable", command: "droid" } as const;
let child: FakeLineProcess = fakeLineProcess();
function serve(result: unknown, error?: unknown): void {
  child = fakeLineProcess((line, process) => {
    const request = asRecord(JSON.parse(line));
    queueMicrotask(() => { process.emit(`${JSON.stringify({ type: "response", id: request?.id, result, error })}\n`); });
  });
  spawn.mockReturnValue(child);
}
afterEach(() => { spawn.mockReset(); vi.useRealTimers(); });

test("Factory queries metadata before a session and preserves native provenance and disabled entries", async () => {
  serve({ skills: [
    { name: "builtin", filePath: "builtin:example", location: "builtin", content: "PRIVATE_BODY" },
    { name: "personal", description: "fixture", location: "personal", enabled: false, userInvocable: true },
    { name: "project", location: "project", enabled: true, userInvocable: false },
    { name: "plugin", location: "personal", pluginId: "example@marketplace", pluginScope: "user", resources: ["PRIVATE_RESOURCE"] },
    { name: "auto", location: "automation" }, { name: "future", location: "future" }, { name: "unknown" },
  ], projectAvailable: true });
  const result = await factoryRuntime.skills(installation, { cwd: "/project", env: readerEnvironment() });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: false, scope: { cwd: resolve("/project") }, items: [
    { name: "builtin", path: "builtin:example", source: "builtin", scope: "builtin" },
    { name: "personal", description: "fixture", source: "personal", scope: "user", enabled: false, userInvocable: true },
    { name: "project", source: "project", scope: "project", enabled: true, userInvocable: false },
    { name: "plugin", source: "personal", scope: "user", plugin: "example@marketplace" },
    { name: "auto", source: "automation", scope: "other" }, { name: "future", source: "future" }, { name: "unknown" },
  ] });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|disableModelInvocation/u);
  expect(child.written.map(line => { const message: unknown = JSON.parse(line); return message; })).toEqual([
    expect.objectContaining({ method: "droid.list_skills", params: { includeContent: false } }),
  ]);
  expect(child.killed()).toBe(true);
  expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(["droid", ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"]]);
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: resolve("/project"), killTree: true, shutdown: "stdin" });
  expectReaderEnvironment(spawn.mock.calls[0]?.[2]?.env);
});

test.each([undefined, true, false])("Factory project availability %s controls partial, empty is valid", async (projectAvailable) => {
  serve({ skills: [], projectAvailable });
  await expect(factoryRuntime.skills(installation)).resolves.toMatchObject({ kind: "ok", items: [], partial: projectAvailable === false });
});

test.each([{}, { skills: null }, { skills: [null] }, { skills: [{}] }, { skills: [], projectAvailable: "PRIVATE" }])("malformed Factory catalog is unavailable: %j", async (result) => {
  serve(result);
  await expect(factoryRuntime.skills(installation)).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
  expect(child.killed()).toBe(true);
});

test("native method absence is unsupported, other failures stay generic", async () => {
  serve(undefined, { code: -32_601, message: "PRIVATE" });
  await expect(factoryRuntime.skills(installation)).resolves.toMatchObject({ kind: "unsupported", code: "native_query_unavailable" });
  serve(undefined, { code: -32_000, message: "PRIVATE" });
  await expect(factoryRuntime.skills(installation)).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
});

// oxlint-disable-next-line max-statements -- Observe the pending result across native process exit.
test("Factory timeout starts cleanup of its owned process", async () => {
  vi.useFakeTimers();
  child = fakeLineProcess();
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {});
  spawn.mockReturnValue(child);
  let settled = false;
  const reading = (async () => {
    try { return await factoryRuntime.skills(installation, { timeoutMs: 25 }); }
    finally { settled = true; }
  })();
  await vi.advanceTimersByTimeAsync(25);
  expect(kill).toHaveBeenCalledOnce();
  expect(settled).toBe(true);
  child.end(null);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
});

test.each([0, -1, Infinity, NaN])("invalid Factory deadline refuses before spawning: %s", async (timeoutMs) => {
  await expect(factoryRuntime.skills(installation, { timeoutMs })).rejects.toThrow(RangeError);
  expect(spawn).not.toHaveBeenCalled();
});
test("Factory requires an executable", async () => {
  await expect(factoryRuntime.skills({ kind: "available", via: "bundled" })).resolves.toMatchObject({ kind: "unsupported", code: "installation_unsupported" });
  expect(spawn).not.toHaveBeenCalled();
});

test("Factory leaves absent and malformed invocation flags unknown", async () => {
  serve({ skills: [{ name: "absent" }, { name: "invalid", userInvocable: "false" }] });
  const result = await factoryRuntime.skills(installation);
  expect(result).toMatchObject({ kind: "ok" });
  if (result.kind === "ok") { expect(result.items).toEqual([{ name: "absent" }, { name: "invalid" }]); }
});
