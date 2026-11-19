import { fstatSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import type { ExecutableRunner, LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({ ...await original<object>(), spawnLineProcess: spawn }));
const installation = { kind: "available", via: "executable", command: "opencode", version: "opencode v2.3.0" } as const;
const versionRun = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable: versionRun }));
const paths: string[] = [];
let fake = fakeLineProcess();
function serve(skills: unknown = [], plugins: unknown = [{ state: { status: "active" } }], directory = "/project") {
  fake = fakeLineProcess();
  spawn.mockImplementation(() => { queueMicrotask(() => { fake.emit("server listening on http://127.0.0.1:45678\n"); }); return fake; });
  // oxlint-disable-next-line max-statements -- Validate the entire private HTTP exchange before returning its fixture.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(new URL(url).origin).toBe("http://127.0.0.1:45678");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-opencode-directory")).toBe(encodeURIComponent(resolve(directory)));
    const password = spawn.mock.calls[0]?.[2]?.env?.OPENCODE_PASSWORD;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
    const path = new URL(url).pathname;
    paths.push(path);
    let data: unknown = [];
    if (path === "/api/skill") { data = skills; }
    if (path === "/api/plugin") { data = plugins; }
    return Response.json({ location: { directory: resolve(directory) }, data });
  }));
}
afterEach(() => { versionRun.mockReset(); spawn.mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); paths.length = 0; });

test("v2 reads skills only after native activation settles and omits bodies", async () => {
  serve([{ id: "review", name: "Review", description: "Check", path: "/project/.agents/skills/review/SKILL.md", autoinvoke: false, content: "PRIVATE BODY" }]);
  const result = await opencodeRuntime.skills(installation, { cwd: "/project", env: readerEnvironment() });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: false, items: [{ name: "Review", description: "Check", path: "/project/.agents/skills/review/SKILL.md", disableModelInvocation: true }] });
  expect(paths).toEqual(["/api/provider", "/api/plugin", "/api/skill"]);
  expect(spawn.mock.calls[0]?.[1]).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  expectReaderEnvironment(spawn.mock.calls[0]?.[2]?.env);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE BODY|Basic/u);
  expect(fake.killed()).toBe(true);
});

test.each([
  ["2.2.7", "builtin"], ["opencode v2.3.0", "builtin"],
  ["2.2.8", undefined], ["2.3.2", undefined], ["2.4.0", undefined],
  ["2.2.7-rc.1", undefined], ["2.3.0+custom", undefined], ["2.03.0", undefined],
] as const)("v2 builtin skill identities are verified for the exact release: %s", async (version, scope) => {
  const uris = ["skill://opencode/SKILL.md", "skill://report/SKILL.md", "skill://third-party/SKILL.md"];
  serve(uris.map(path => ({ name: path, path })));
  const result = await opencodeRuntime.skills({ ...installation, version }, { cwd: "/project" });
  expect(result).toMatchObject({ kind: "ok", partial: false });
  if (result.kind === "ok") {
    expect(result.items.map(item => ({ name: item.name, path: item.path, scope: item.scope, source: item.source })))
      .toEqual(uris.map((path, index) => ({ name: path, path, scope: index < 2 ? scope : undefined, source: undefined })));
  }
  expect(versionRun).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledOnce();
});

test.each([["2.2.7", "builtin"], ["2.3.2", undefined]] as const)("detected version %s controls builtin skill scope without an extra query", async (version, scope) => {
  versionRun.mockResolvedValue({ ok: true, stdout: version, stderr: "", exitCode: 0 });
  serve([{ name: "opencode", path: "skill://opencode/SKILL.md" }]);
  const result = await opencodeRuntime.skills({ kind: "available", via: "executable", command: "opencode" }, { cwd: "/project" });
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") { expect(result.items[0]?.scope).toBe(scope); }
  expect(versionRun).toHaveBeenCalledOnce(); expect(versionRun.mock.calls[0]?.[1]).toEqual(["--version"]);
  expect(spawn).toHaveBeenCalledOnce();
});

test.each([{ plugins: [], partial: false }, { plugins: [{ state: { status: "failed", error: "PRIVATE FAILURE" } }], partial: true }])("empty catalog is partial only for failed plugins: $partial", async ({ plugins, partial }) => {
  serve([], plugins);
  await expect(opencodeRuntime.skills(installation, { cwd: "/project" })).resolves.toMatchObject({ kind: "ok", items: [], partial });
  expect(fake.killed()).toBe(true);
});

test.each([null, [{}], [{ name: "ok" }]])("malformed v2 skill catalogs fail: %j", async (skills) => {
  serve(skills);
  await expect(opencodeRuntime.skills(installation, { cwd: "/project" })).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(fake.killed()).toBe(true);
});

test("failed native activation never reads an empty skill catalog", async () => {
  serve();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private plugin failure", { status: 503 })));
  await expect(opencodeRuntime.skills(installation, { cwd: "/project" })).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fake.killed()).toBe(true);
});

// oxlint-disable-next-line max-statements -- Keep deadline, cancellation and exit observations in one timeline.
test("timeout aborts native requests and starts process cleanup", async () => {
  vi.useFakeTimers(); serve();
  const observation: { signal?: AbortSignal | null } = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { observation.signal = init?.signal ?? null; return Promise.withResolvers<Response>().promise; }));
  const kill = vi.spyOn(fake, "kill").mockImplementation(() => {});
  const reading = opencodeRuntime.skills(installation, { cwd: "/project", timeoutMs: 25 });
  await vi.advanceTimersByTimeAsync(25);
  expect(observation.signal?.aborted).toBe(true); expect(kill).toHaveBeenCalledOnce();
  fake.end(null);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
});

test("v1 debug skill returns native metadata and builtin provenance", async () => {
  versionRun.mockImplementation(async (_command, _args, options) => {
    if (options?.stdoutFd === undefined) { throw new Error("Missing output file"); }
    writeSync(options.stdoutFd, JSON.stringify([{ name: "builtin", location: "<built-in>", content: "body" }, { name: "shared", location: "/home/.claude/skills/shared/SKILL.md" }]));
    return { ok: true, exitCode: null, stderr: "", stdout: "" };
  });
  const result = await opencodeRuntime.skills({ ...installation, version: "1.18.30" }, { cwd: "/project", env: readerEnvironment() });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", items: [{ name: "builtin", source: "builtin", scope: "builtin" }, { name: "shared", path: "/home/.claude/skills/shared/SKILL.md" }] });
  if (result.kind === "ok") { expect(result.items[0]).not.toHaveProperty("path"); }
  expect(versionRun.mock.calls[0]?.[1]).toEqual(["debug", "skill"]);
  expectReaderEnvironment(versionRun.mock.calls[0]?.[2]?.env);
  expect(spawn).not.toHaveBeenCalled();
});

test("a v2 version before the verified activation API is explicitly unsupported", async () => {
  await expect(opencodeRuntime.skills({ ...installation, version: "2.0.26" })).resolves.toMatchObject({ kind: "unsupported", code: "version_unsupported", requiredVersion: "2.2.7" });
  expect(spawn).not.toHaveBeenCalled();
});


test.each([{ payload: "not json", code: 0, reason: "OpenCode skill discovery failed (exit 0; output was not valid JSON or a skill catalog (8 bytes, truncated?))" }, { payload: "", code: 0, reason: "OpenCode skill discovery failed (exit 0; no output)" }, { payload: "[]", code: 1, reason: "OpenCode skill discovery failed (exit 1)" }])("v1 invalid output or process failure is unavailable: $code", async ({ payload, code, reason }) => {
  versionRun.mockImplementation(async (_command, _args, options) => {
    if (options?.stdoutFd === undefined) { throw new Error("Missing output file"); }
    writeSync(options.stdoutFd, payload);
    return { ok: code === 0, exitCode: code === 0 ? null : code, stdout: "", stderr: "" };
  });
  await expect(opencodeRuntime.skills({ ...installation, version: "1.19.5" })).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason });
  const fd = versionRun.mock.calls[0]?.[2]?.stdoutFd;
  expect(fd).toBeTypeOf("number");
  expect(() => fstatSync(fd ?? -1)).toThrow();
});

// oxlint-disable-next-line max-statements -- Observe deadline, abort and delayed process disposal together.
test("v1 startup timeout cancels the process and lets cleanup continue", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<Awaited<ReturnType<ExecutableRunner>>>();
  const state = { aborted: false, returned: false };
  const entered = Promise.withResolvers<void>();
  versionRun.mockImplementation(async (_command, _args, options) => {
    if (options?.signal === undefined) { throw new Error("Missing signal"); }
    options.signal.addEventListener("abort", () => { state.aborted = true; }, { once: true });
    entered.resolve();
    return pending.promise;
  });
  const reading = opencodeRuntime.skills({ ...installation, version: "1.18.30" }, { timeoutMs: 25 });
  const observed = (async () => { await reading; state.returned = true; })();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(25);
  expect(state).toEqual({ aborted: true, returned: true });
  pending.resolve({ ok: false, exitCode: null, stderr: "", stdout: "" });
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  await observed;
});

test("the deadline also cancels and settles version detection before any inventory launch", async () => {
  vi.useFakeTimers();
  const observation = { stopped: false };
  versionRun.mockImplementation(async (_command, _args, options) => {
    if (options?.signal === undefined) { throw new Error("Missing signal"); }
    const pending = Promise.withResolvers<Awaited<ReturnType<ExecutableRunner>>>();
    options.signal.addEventListener("abort", () => { observation.stopped = true; pending.resolve({ ok: false, exitCode: null, stdout: "", stderr: "" }); }, { once: true });
    return pending.promise;
  });
  const reading = opencodeRuntime.skills({ kind: "available", via: "executable", command: "opencode" }, { timeoutMs: 25 });
  await vi.advanceTimersByTimeAsync(25);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(observation.stopped).toBe(true); expect(spawn).not.toHaveBeenCalled();
});


// oxlint-disable-next-line max-statements -- Exercise actual Windows aliases through the public reader in both directions.
test.skipIf(process.platform !== "win32")("Windows skill scope resolves 8.3 aliases while preserving the native path string", async context => {
  const root = await mkdtemp(join(tmpdir(), "oar skill provenance "));
  try {
    const home = join(root, "home"); const cwd = join(root, "project");
    const user = join(home, ".claude", "skills", "fixture", "SKILL.md");
    const project = join(cwd, ".agents", "skills", "fixture", "SKILL.md");
    await Promise.all([user, project].map(async path => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, "fixture"); }));
    const longRoot = await realpath(root);
    const shortRoot = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
      "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:OAR_SKILL_LONG_PATH).ShortPath",
    ].join("; ")], { env: { ...process.env, OAR_SKILL_LONG_PATH: longRoot }, encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
    if (shortRoot.toLowerCase() === longRoot.toLowerCase()) { context.skip("This volume exposes no distinct Windows 8.3 alias"); }
    for (const [native, launch] of [[longRoot, shortRoot], [shortRoot, longRoot]] as const) {
      const userPath = join(native, "home", ".claude", "skills", "fixture", "SKILL.md");
      const projectPath = join(native, "project", ".agents", "skills", "fixture", "SKILL.md");
      spawn.mockClear();
      serve([{ name: "user", path: userPath }, { name: "project", path: projectPath }], undefined, join(launch, "project"));
      // oxlint-disable-next-line no-await-in-loop -- Each direction owns and disposes its discovery process before the next.
      const result = await opencodeRuntime.skills(installation, { cwd: join(launch, "project"), env: { HOME: join(launch, "home"), USERPROFILE: join(launch, "home"), OPENCODE_TEST_HOME: null, OPENCODE_CONFIG_DIR: null } });
      expect(result).toMatchObject({ kind: "ok", items: [
        { name: "user", path: userPath, scope: "user" }, { name: "project", path: projectPath, scope: "project" },
      ] });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
