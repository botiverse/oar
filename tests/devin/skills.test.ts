import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { devinRuntime } from "../../packages/oar/src/runtimes/devin/index.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({ ...await original<object>(), spawnLineProcess: spawn }));
const installation = { kind: "available", via: "executable", command: "devin" } as const;
let child: FakeLineProcess = fakeLineProcess();
function serve(payload: unknown, code = 0): void {
  child = fakeLineProcess();
  spawn.mockImplementation(() => {
    queueMicrotask(() => { child.emit(`${JSON.stringify(payload)}\n`); child.end(code); });
    return child;
  });
}
afterEach(() => { spawn.mockReset(); vi.useRealTimers(); });

test("Devin reads native metadata without a session or skill body and preserves source", async () => {
  serve([
    { name: "devin-cli", provider: "Builtin", base_dir: "", triggers: ["model"], body: "PRIVATE_BODY", errors: [], warnings: [] },
    { name: "project", description: "Fixture", provider: "Devin", base_dir: "/project/.devin/skills/project", triggers: ["user"], errors: [], warnings: [] },
    { name: "compat", provider: "Claude", triggers: ["user", "model"] },
    { name: "unknown", provider: "Future", triggers: [] },
    { name: "missing-fields" },
  ]);
  const result = await devinRuntime.skills(installation, { cwd: "/project", env: readerEnvironment() });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: false, scope: { kind: "workspace", cwd: resolve("/project") }, items: [
    { name: "devin-cli", source: "Builtin", scope: "builtin", disableModelInvocation: false },
    { name: "project", description: "Fixture", source: "Devin", path: "/project/.devin/skills/project", disableModelInvocation: true },
    { name: "compat", source: "Claude", disableModelInvocation: false },
    { name: "unknown", source: "Future", disableModelInvocation: true },
    { name: "missing-fields" },
  ] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(["devin", ["skills", "list", "--json"]]);
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: resolve("/project"), killTree: true, inheritStderr: false });
  expectReaderEnvironment(spawn.mock.calls[0]?.[2]?.env);
});

test.each(["warnings", "errors"])("Devin retains entries and maps %s without exposing native diagnostics", async (key) => {
  serve([{ name: "diagnostic", [key]: ["PRIVATE_DIAGNOSTIC"] }]);
  const result = await devinRuntime.skills(installation);
  expect(result).toMatchObject({ kind: "ok", partial: key === "errors", items: [{ name: "diagnostic" }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_DIAGNOSTIC");
});

test.each([null, {}, [null], [{}], [{ name: "x", errors: "PRIVATE_ERROR" }], [{ name: "x", triggers: [17] }]])("malformed Devin catalog fails instead of becoming empty: %j", async (payload) => {
  serve(payload);
  await expect(devinRuntime.skills(installation)).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
});

test("Devin accepts an empty native catalog", async () => {
  serve([]);
  await expect(devinRuntime.skills(installation)).resolves.toMatchObject({ kind: "ok", items: [], partial: false });
});

test("Devin native failure does not expose output", async () => {
  serve("PRIVATE_FAILURE", 1);
  await expect(devinRuntime.skills(installation)).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
});

// oxlint-disable-next-line max-statements -- Verify deadline settlement waits for the owned process to exit.
test("Devin timeout kills and awaits its process", async () => {
  vi.useFakeTimers();
  child = fakeLineProcess();
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {});
  spawn.mockReturnValue(child);
  let settled = false;
  const reading = (async () => {
    try { return await devinRuntime.skills(installation, { timeoutMs: 25 }); }
    finally { settled = true; }
  })();
  await vi.advanceTimersByTimeAsync(25);
  expect(kill).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  child.end(null);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
});

test.each([0, -1, Infinity, NaN])("Devin rejects invalid deadline before spawning: %s", async (timeoutMs) => {
  await expect(devinRuntime.skills(installation, { timeoutMs })).rejects.toThrow(RangeError);
  expect(spawn).not.toHaveBeenCalled();
});

test("Devin refuses non-executable installation without spawning", async () => {
  await expect(devinRuntime.skills({ kind: "available", via: "bundled" })).resolves.toMatchObject({ kind: "unsupported", code: "installation_unsupported" });
  expect(spawn).not.toHaveBeenCalled();
});
