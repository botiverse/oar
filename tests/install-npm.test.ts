import path from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableResult, ExecutableRunner } from "../packages/oar/src/shared/executable/run.js";
import type { InstallHost } from "../packages/oar/src/shared/install.js";
import { npmGlobalBin, npmGlobalPrefix, npmInstallPlan } from "../packages/oar/src/shared/install-npm.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); });
const method = { packageName: "@vendor/agent", source: "https://example.invalid/install" };
const prefix = path.resolve("npm-prefix");
const host: InstallHost = { platform: "linux", arch: "x64", locate: () => "npm", unwritable: () => null };
const steps = [{ command: ["npm", "install", "-g", method.packageName], display: `npm install -g ${method.packageName}` }];
function prefixResult(): void { runExecutable.mockResolvedValue({ ok: true, exitCode: null, stdout: `${prefix}\n`, stderr: "" }); }

test.each(["linux", "darwin", "win32"] as const)("npm installation on %s uses the vendor's global package", async (platform) => {
  prefixResult();
  await expect(npmInstallPlan(method, { ...host, platform })()).resolves.toEqual({ kind: "plan", steps, source: method.source, network: true, privileges: false });
});

test("a missing npm preserves the manual command and source without querying configuration", async () => {
  await expect(npmInstallPlan(method, { ...host, locate: () => null })()).resolves.toEqual({ kind: "unsupported", reason: "missing_tool", detail: "npm", steps, source: method.source });
  expect(runExecutable).not.toHaveBeenCalled();
});

test.each(["prefix", "package"])("an unwritable %s refuses installation with the vendor steps", async (target) => {
  prefixResult();
  const blocked = target === "prefix" ? prefix : path.join(prefix, "lib", "node_modules", method.packageName);
  const result = await npmInstallPlan(method, { ...host, unwritable: (directory) => directory === blocked ? blocked : null })();
  expect(result).toMatchObject({ kind: "unsupported", reason: "requires_privileges", steps, source: method.source });
  expect(result.kind === "unsupported" ? result.detail : undefined).toContain(blocked);
});

test("the prefix query is bounded, suppresses logging and keeps npm configuration but strips script markers", async () => {
  prefixResult();
  const env = { npm_config_prefix: prefix, npm_lifecycle_event: "check", HOME: path.resolve("isolated-home") };
  await expect(npmGlobalPrefix("npm", env)).resolves.toBe(prefix);
  expect(runExecutable).toHaveBeenCalledWith("npm", ["prefix", "-g", "--cache", expect.any(String), "--loglevel=error", "--logs-max=0", "--timing=false", "--update-notifier=false"], {
    timeoutMs: 15_000, env: { npm_config_prefix: prefix, HOME: env.HOME },
  });
});

const failedQueries: readonly { readonly mode: string; readonly result: ExecutableResult; readonly category: string }[] = [
  { mode: "exit", result: { ok: false, exitCode: 7, stdout: prefix, stderr: "private stderr" }, category: "query exited with code 7" },
  { mode: "timeout", result: { ok: false, exitCode: null, stdout: "private stdout", stderr: "private stderr", diagnostics: { exitCode: null, signal: "SIGTERM", timeoutMs: 15_000, stderr: "private tail" } }, category: "query timed out after 15000 ms" },
  { mode: "spawn", result: { ok: false, exitCode: null, stdout: "", stderr: "", diagnostics: { exitCode: null, signal: null, stderr: "private tail", error: { code: "ENOENT", message: "private path" } } }, category: "query could not start or complete" },
  { mode: "relative", result: { ok: true, exitCode: null, stdout: "private-relative-path", stderr: "private stderr" }, category: "query output is not an absolute path" },
  { mode: "empty", result: { ok: true, exitCode: null, stdout: "\n", stderr: "" }, category: "query output is not an absolute path" },
  { mode: "multiple", result: { ok: true, exitCode: null, stdout: `${prefix}\nprivate extra`, stderr: "" }, category: "query output is not a single path" },
  { mode: "null byte", result: { ok: true, exitCode: null, stdout: `${prefix}\0private extra`, stderr: "" }, category: "query output is not a single path" },
];

test.each(failedQueries)("a $mode prefix query returns its category without native output or an installation attempt", async ({ result, category }) => {
  const unwritable = vi.fn(() => null);
  runExecutable.mockImplementation(async () => {
    writeFileSync(path.join(capturedCache(), "npm-log"), "private npm details");
    return result;
  });
  await expect(npmInstallPlan(method, { ...host, unwritable })()).resolves.toEqual({
    kind: "unsupported", reason: "location_unknown", detail: `Could not determine npm's global installation directory: ${category}.`, steps, source: method.source,
  });
  expect(unwritable).not.toHaveBeenCalled();
  expect(runExecutable).toHaveBeenCalledTimes(1);
  expect(existsSync(capturedCache())).toBe(false);
});

test("a rejected prefix query returns a safe category and removes its temporary cache", async () => {
  runExecutable.mockRejectedValue(new Error("unexpected private failure"));
  await expect(npmInstallPlan(method, host)()).resolves.toEqual({
    kind: "unsupported", reason: "location_unknown", detail: "Could not determine npm's global installation directory: local query failed.", steps, source: method.source,
  });
  expect(existsSync(capturedCache())).toBe(false);
});

test("errors after a successful prefix query are not converted into location_unknown", async () => {
  prefixResult();
  const error = new Error("unexpected host error");
  await expect(npmInstallPlan(method, { ...host, unwritable: () => { throw error; } })()).rejects.toBe(error);
});

test("unsupported OS and release lines do not query npm; global bin placement follows the platform", async () => {
  await expect(npmInstallPlan(method, { ...host, platform: "freebsd" })()).resolves.toMatchObject({ kind: "unsupported", reason: "platform" });
  await expect(npmInstallPlan(method, host)({ line: "beta" })).resolves.toMatchObject({ kind: "unsupported", reason: "unknown_line" });
  expect(runExecutable).not.toHaveBeenCalled();
  expect(npmGlobalBin(prefix, "win32")).toBe(prefix);
  expect(npmGlobalBin(prefix, "darwin")).toBe(path.join(prefix, "bin"));
});

function capturedCache(): string {
  const cache = runExecutable.mock.calls.at(-1)?.[1][3];
  if (cache === undefined) { throw new Error("missing query cache argument"); }
  return cache;
}

test.each([true, false])("prefix query owns a private temporary cache and removes writes after success=%s", async (ok) => {
  runExecutable.mockImplementation(async () => {
    const cache = capturedCache();
    expect(path.dirname(cache)).toBe(tmpdir());
    if (process.platform !== "win32") { expect(statSync(cache).mode & 0o777).toBe(0o700); }
    writeFileSync(path.join(cache, "unexpected-npm-write"), "fixture");
    return { ok, exitCode: ok ? 0 : 1, stdout: `${prefix}\n`, stderr: "" };
  });
  const query = npmGlobalPrefix("npm");
  await (ok ? expect(query).resolves.toBe(prefix) : expect(query).rejects.toThrow("query exited with code 1"));
  expect(existsSync(capturedCache())).toBe(false);
});
