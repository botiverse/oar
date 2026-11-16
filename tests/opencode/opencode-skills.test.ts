import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";
import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({ ...await original<object>(), spawnLineProcess: spawn }));
const installation = { kind: "available", via: "executable", command: "opencode", version: "opencode v2.3.0" } as const;
const versionRun = vi.hoisted(() => vi.fn());
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
test("timeout aborts native requests and waits for process exit", async () => {
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
  fake = fakeLineProcess();
  spawn.mockImplementation(() => {
    queueMicrotask(() => { fake.emit(JSON.stringify([{ name: "builtin", location: "<built-in>", content: "body" }, { name: "shared", location: "/home/.claude/skills/shared/SKILL.md" }])); fake.end(0); });
    return fake;
  });
  const result = await opencodeRuntime.skills({ ...installation, version: "1.19.5" }, { cwd: "/project" });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", items: [{ name: "builtin", source: "builtin" }, { name: "shared", path: "/home/.claude/skills/shared/SKILL.md" }] });
  expect(spawn.mock.calls[0]?.[1]).toEqual(["debug", "skill"]);
});

test("a v2 version before the verified activation API is explicitly unsupported", async () => {
  await expect(opencodeRuntime.skills({ ...installation, version: "2.0.26" })).resolves.toMatchObject({ kind: "unsupported", code: "version_unsupported", requiredVersion: "2.2.7" });
  expect(spawn).not.toHaveBeenCalled();
});


test.each([{ payload: "not json", code: 0 }, { payload: "[]", code: 1 }])("v1 invalid output or process failure is unavailable: $code", async ({ payload, code }) => {
  fake = fakeLineProcess();
  spawn.mockImplementation(() => { queueMicrotask(() => { fake.emit(payload); fake.end(code); }); return fake; });
  await expect(opencodeRuntime.skills({ ...installation, version: "1.19.5" })).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(fake.killed()).toBe(true);
});

test("v1 startup timeout kills its process", async () => {
  vi.useFakeTimers(); fake = fakeLineProcess(); spawn.mockReturnValue(fake);
  const reading = opencodeRuntime.skills({ ...installation, version: "1.19.5" }, { timeoutMs: 25 });
  await vi.advanceTimersByTimeAsync(25);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(fake.killed()).toBe(true);
});


test("the deadline also cancels and settles version detection before any inventory launch", async () => {
  vi.useFakeTimers();
  const observation = { stopped: false };
  versionRun.mockImplementation(async (_command: string, _args: string[], options: { signal: AbortSignal }) => {
    const pending = Promise.withResolvers<unknown>();
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
