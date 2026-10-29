import path from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../packages/oar/src/shared/executable/run.js";
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

test.each(["failed", "timeout", "relative", "multiple"])("a %s prefix query cannot authorize an install", async (mode) => {
  const output: Record<string, string> = { relative: "relative/path", multiple: `${prefix}\nextra` };
  runExecutable.mockResolvedValue({ ok: mode === "relative" || mode === "multiple", exitCode: mode === "failed" ? 1 : null,
    stdout: output[mode] ?? "", stderr: "unexpected native secret" });
  await expect(npmInstallPlan(method, host)()).rejects.toThrow(/^Could not read npm's global installation directory$/u);
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
  await (ok ? expect(query).resolves.toBe(prefix) : expect(query).rejects.toThrow("Could not read npm"));
  expect(existsSync(capturedCache())).toBe(false);
});
