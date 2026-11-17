import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import type { ExecutableRunner, ExecutableResult } from "../../packages/oar/src/shared/executable/run.js";
import type { AuthStatus } from "../../packages/oar/src/contracts/login.js";

const mocks = vi.hoisted(() => ({ auth: vi.fn<() => Promise<AuthStatus>>(), run: vi.fn<ExecutableRunner>() }));
vi.mock("../../packages/oar/src/runtimes/antigravity/auth.js", async original => ({ ...await original<object>(), readAntigravityAuthStatus: mocks.auth }));
vi.mock("../../packages/oar/src/shared/executable/index.js", async original => ({ ...await original<object>(), runExecutable: mocks.run }));
const installation = { kind: "available", via: "executable", command: "agy", version: "1.5.9" } as const;
function serve(skills: unknown = []): void {
  mocks.auth.mockResolvedValue({ kind: "logged_in", source: "fixture" });
  mocks.run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ status: "SUCCESS", conversation_id: "", num_turns: 0, command: { name: "skills", data: { skills } } }), stderr: "", exitCode: 0 });
}
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

test("native skill metadata preserves builtin provenance and invocation flags without inventing scope", async () => {
  serve([{ name: "builtin", description: "native", path: "/built/SKILL.md", builtin: true, model_invocable: true, body: "PRIVATE_BODY" },
    { name: "user", builtin: false, model_invocable: false, plugin: "native-plugin" }, { name: "unknown" }]);
  const result = await antigravityRuntime.skills(installation, { cwd: "/project", env: { GEMINI_HOME: null, AGY_CLI_DISABLE_AUTO_UPDATE: "false" } });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: false, scope: { kind: "workspace", cwd: resolve("/project") }, items: [
    { name: "builtin", description: "native", path: "/built/SKILL.md", scope: "builtin", disableModelInvocation: false },
    { name: "user", plugin: "native-plugin", disableModelInvocation: true }, { name: "unknown" },
  ] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  expect(mocks.run.mock.calls[0]?.slice(0, 2)).toEqual(["agy", ["--output-format", "json", "--print=/skills"]]);
  expect(mocks.run.mock.calls[0]?.[2]).toMatchObject({ cwd: resolve("/project"), env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } });
  expect(mocks.auth.mock.calls[0]).toMatchObject([installation, { env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } }]);
});

test("signed-out discovery refuses before print mode can initiate login", async () => {
  serve(); mocks.auth.mockResolvedValue({ kind: "logged_out", source: "agy models" });
  await expect(antigravityRuntime.skills(installation, { env: { GEMINI_HOME: null } })).resolves.toMatchObject({ kind: "unavailable", code: "not_authenticated", reason: "Sign in to Antigravity to read its skills." });
  expect(mocks.run).not.toHaveBeenCalled();
});
test("unknown authentication does not run print mode or expose native diagnostics", async () => {
  serve(); mocks.auth.mockResolvedValue({ kind: "unknown", detail: "PRIVATE_AUTH" });
  await expect(antigravityRuntime.skills(installation, { env: { GEMINI_HOME: null } })).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(mocks.run).not.toHaveBeenCalled();
});
test("custom GEMINI_HOME is refused instead of inspecting a different profile", async () => {
  serve();
  await expect(antigravityRuntime.skills(installation, { env: { HOME: "/one", USERPROFILE: "/one", GEMINI_HOME: "/two" } })).resolves.toMatchObject({ kind: "unsupported", code: "scope_unavailable" });
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});
test("version floor precedes authentication and the query", async () => {
  serve();
  await expect(antigravityRuntime.skills({ ...installation, version: "1.4.9" }, { env: { GEMINI_HOME: null } })).resolves.toMatchObject({ kind: "unsupported", code: "version_unsupported", requiredVersion: "1.5.0" });
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});
test.each([null, {}, [null], [{}], [{ name: "x", builtin: "yes" }], [{ name: "x", model_invocable: 1 }]])("malformed catalog is unavailable: %j", async skills => {
  serve(skills);
  await expect(antigravityRuntime.skills(installation, { env: { GEMINI_HOME: null } })).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Antigravity skill query failed." });
});
test.each([
  { status: "ERROR", error: "PRIVATE_ERROR" },
  { status: "SUCCESS", command: { name: "other", data: { skills: [] } } },
  { status: "SUCCESS", conversation_id: "created", num_turns: 1, command: { name: "skills", data: { skills: [] } } },
])("unexpected print response cannot become a successful inventory: %j", async payload => {
  serve(); mocks.run.mockResolvedValue({ ok: true, stdout: JSON.stringify(payload), stderr: "", exitCode: 0 });
  await expect(antigravityRuntime.skills(installation, { env: { GEMINI_HOME: null } })).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
});
test("native failures are sanitized", async () => {
  serve(); mocks.run.mockRejectedValue(new Error("PRIVATE_OUTPUT"));
  await expect(antigravityRuntime.skills(installation, { env: { GEMINI_HOME: null } })).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Antigravity skill query failed." });
});
test("timeout aborts in-flight native work", async () => {
  vi.useFakeTimers(); serve();
  const held = Promise.withResolvers<ExecutableResult>(); mocks.run.mockImplementation(async () => held.promise);
  const pending = antigravityRuntime.skills(installation, { timeoutMs: 25, env: { GEMINI_HOME: null } });
  await vi.advanceTimersByTimeAsync(25);
  await expect(pending).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(mocks.run.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  held.resolve({ ok: false, stdout: "", stderr: "", exitCode: null });
});
test.each([0, -1, Infinity, NaN])("invalid deadline is rejected before native work: %s", async timeoutMs => {
  serve(); await expect(antigravityRuntime.skills(installation, { timeoutMs })).rejects.toThrow(RangeError);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});
