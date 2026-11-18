/* oxlint-disable max-statements -- Keep queue and process lifecycle observations in chronological order. */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireKimiWebStartup, startKimiWeb } from "../../packages/oar/src/runtimes/kimi/web-startup.js";
import { kimiSkills } from "../../packages/oar/src/runtimes/kimi/skills.js";
import { kimiNativeUsage } from "../../packages/oar/src/runtimes/kimi/native-usage.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import type { LineProcessOptions } from "../../packages/oar/src/shared/executable/index.js";

const spawn = vi.hoisted(() => vi.fn<(command: string, args: readonly string[], options?: LineProcessOptions) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", async original => ({ ...await original<object>(), spawnLineProcess: spawn }));
const roots: string[] = [];
const signal = (): AbortSignal => new AbortController().signal;
const ready = (child: FakeLineProcess): void => { child.emit("http://127.0.0.1:45678/#token=synthetic-test-token\n"); };
const installation = { kind: "available", via: "executable", command: "kimi" } as const;

async function setup(): Promise<{ env: Record<string, string>; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "kimi-startup-test-")); roots.push(home);
  return { env: { KIMI_CODE_HOME: home }, home };
}

afterEach(async () => {
  spawn.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }); }));
});

test("cancelled waiters and stale releases never release another owner", async () => {
  const { env, home } = await setup();
  const owner = await acquireKimiWebStartup(env, home, signal());
  const abort = new AbortController();
  const cancelled = expect(acquireKimiWebStartup(env, home, abort.signal)).rejects.toThrow("cancelled");
  let granted = false;
  const next = (async () => { const release = await acquireKimiWebStartup(env, home, signal()); granted = true; return release; })();
  abort.abort(new Error("cancelled")); await cancelled;
  expect(granted).toBe(false);
  owner(); const release = await next; owner();
  const last = new AbortController(); let lastGranted = false;
  const waiting = (async () => { const free = await acquireKimiWebStartup(env, home, last.signal); lastGranted = true; free(); })();
  const rejected = expect(waiting).rejects.toThrow("still owned");
  await Promise.resolve(); expect(lastGranted).toBe(false);
  last.abort(new Error("still owned")); await rejected;
  release(); (await acquireKimiWebStartup(env, home, signal()))();
});

test("a pre-aborted call never takes ownership or spawns", async () => {
  const { env, home } = await setup();
  const aborted = AbortSignal.abort(new Error("cancelled"));
  await expect(startKimiWeb("kimi", env, aborted, home)).rejects.toThrow("cancelled");
  expect(spawn).not.toHaveBeenCalled();
  (await acquireKimiWebStartup(env, home, signal()))();
});

test("symlink aliases and HOME fallback share the gate, separate homes do not", async () => {
  const { home } = await setup(); const real = join(home, "real"); const alias = join(home, "alias");
  await mkdir(real); await symlink(real, alias, "junction");
  const env = { [process.platform === "win32" ? "USERPROFILE" : "HOME"]: real };
  const owner = await acquireKimiWebStartup(env, home, signal());
  const abort = new AbortController(); let granted = false;
  const pending = (async () => { const release = await acquireKimiWebStartup({ KIMI_CODE_HOME: "alias/.kimi-code" }, home, abort.signal); granted = true; release(); })();
  const rejected = expect(pending).rejects.toThrow("same home");
  (await acquireKimiWebStartup({ KIMI_CODE_HOME: join(home, "separate") }, home, signal()))();
  await Promise.resolve(); expect(granted).toBe(false);
  abort.abort(new Error("same home")); await rejected; owner();
});

test.each(["", " \n\t"])("native empty token state %j still queues", async contents => {
  const { env, home } = await setup(); await writeFile(join(home, "server.token"), contents);
  const owner = await acquireKimiWebStartup(env, home, signal());
  const abort = new AbortController(); let granted = false;
  const pending = (async () => { const release = await acquireKimiWebStartup(env, home, abort.signal); granted = true; release(); })();
  const rejected = expect(pending).rejects.toThrow("empty");
  await Promise.resolve(); expect(granted).toBe(false);
  abort.abort(new Error("empty")); await rejected; owner();
});

test("native nonempty token bypasses an active gate without validating its format", async () => {
  const { env, home } = await setup();
  const owner = await acquireKimiWebStartup(env, home, signal());
  await writeFile(join(home, "server.token"), " \npartial\t");
  (await acquireKimiWebStartup(env, home, signal()))();
  owner();
});

test("a newly created token releases queued callers without serializing their readiness", async () => {
  const { env, home } = await setup();
  const owner = await acquireKimiWebStartup(env, home, signal());
  const first = acquireKimiWebStartup(env, home, signal());
  const second = acquireKimiWebStartup(env, home, signal());
  await writeFile(join(home, "server.token"), "synthetic-test-token"); owner();
  const release = await first;
  (await second)(); release();
});

test("readiness releases startup while the first process remains alive", async () => {
  const { env, home } = await setup(); const one = fakeLineProcess(); const two = fakeLineProcess();
  spawn.mockReturnValueOnce(one).mockReturnValueOnce(two);
  const first = startKimiWeb("kimi", env, signal(), home);
  const second = startKimiWeb("kimi", env, signal(), home);
  await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(1); });
  ready(one); await first;
  await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2); });
  expect(one.killed()).toBe(false);
  ready(two); await second; one.kill(); two.kill();
});

test.each(["exit", "spawn"])("%s failure releases the gate and never retries", async mode => {
  const { env, home } = await setup(); const one = fakeLineProcess(); const two = fakeLineProcess();
  spawn.mockImplementationOnce(() => { if (mode === "spawn") { throw new Error("spawn failed"); } queueMicrotask(() => { one.end(1); }); return one; }).mockReturnValueOnce(two);
  const first = expect(startKimiWeb("kimi", env, signal(), home)).rejects.toThrow(mode === "spawn" ? "spawn failed" : "exited");
  const second = startKimiWeb("kimi", env, signal(), home);
  await first; await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2); });
  ready(two); await second; two.kill();
});

test("skills queue timeout spawns nothing and leaves the current owner intact", async () => {
  vi.useFakeTimers(); const { env, home } = await setup();
  const owner = await acquireKimiWebStartup(env, home, signal());
  const reading = kimiSkills(installation, { env, cwd: home, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(50);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(spawn).not.toHaveBeenCalled();
  const aborted = new AbortController();
  const pending = expect(acquireKimiWebStartup(env, home, aborted.signal)).rejects.toThrow("owned");
  aborted.abort(new Error("owned")); await pending; owner();
});

test("usage and skills share startup ownership and spend one original deadline", async () => {
  vi.useFakeTimers(); const { env, home } = await setup();
  const auth = { home, credentialPath: join(home, "credentials.json"), baseUrl: "http://localhost", oauthHost: "http://localhost", storage: "file", storageName: "synthetic" } as const;
  const usageChild = fakeLineProcess(); const skillsChild = fakeLineProcess();
  spawn.mockReturnValueOnce(usageChild).mockReturnValueOnce(skillsChild);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/shutdown")) { usageChild.end(0); }
    return Response.json({ code: 0, data: { kind: "ok", quota: { usages: { limit7d: { usedRatio: 0.5 } } } } });
  }));
  const usage = kimiNativeUsage("kimi", auth, env, Date.now() + 100);
  const skills = kimiSkills(installation, { env, cwd: home, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(30); expect(spawn).toHaveBeenCalledTimes(1);
  ready(usageChild); await usage;
  await vi.advanceTimersByTimeAsync(0); expect(spawn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20);
  await expect(skills).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  expect(skillsChild.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});


test("read-only Web processes disable both background catalog refresh paths without mutating caller env", async () => {
  const { env, home } = await setup();
  const caller = { ...env, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "yes", KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "10" };
  const before = { ...caller }; const child = fakeLineProcess();
  spawn.mockReturnValue(child);
  const started = startKimiWeb("kimi", caller, signal(), home);
  await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce(); }); ready(child); await started;
  expect(spawn.mock.calls[0]?.[2]?.env).toStrictEqual({ ...caller, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "0", KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "0" });
  expect(caller).toStrictEqual(before); child.kill(); await child.exited;
});

// oxlint-disable-next-line max-statements -- Observe each deadline and cleanup boundary on one virtual clock.
test.each(["usage", "skills"])("%s returns at its deadline while native shutdown keeps a bounded grace period", async kind => {
  vi.useFakeTimers(); const { env, home } = await setup(); const child = fakeLineProcess(); spawn.mockReturnValue(child);
  const auth = { home, credentialPath: join(home, "credentials.json"), baseUrl: "http://localhost", oauthHost: "http://localhost", storage: "file", storageName: "synthetic" } as const;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(new URL(url).pathname);
    const querySignal = init?.signal; expect(querySignal?.aborted).toBe(false);
    if (url.endsWith("/shutdown")) { return Response.json({ code: 0, data: {} }); }
    const { promise, reject } = Promise.withResolvers<Response>();
    querySignal?.addEventListener("abort", () => { reject(new Error("private request failure")); }, { once: true }); return promise;
  }));
  const usage = async (): Promise<unknown> => {
    try { return await kimiNativeUsage("kimi", auth, env, Date.now() + 50); }
    catch (error) { return error instanceof Error ? error.message : "unexpected"; }
  };
  const pending = kind === "usage"
    ? usage()
    : kimiSkills(installation, { env, cwd: home, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(0); ready(child);
  await vi.advanceTimersByTimeAsync(50);
  await (kind === "usage" ? expect(pending).resolves.toBe("Kimi account usage timed out") : expect(pending).resolves.toMatchObject({ kind: "unavailable", code: "timeout" }));
  expect(calls.at(-1)).toBe("/api/v1/shutdown"); expect(child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1999); expect(child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(child.killed()).toBe(true); await child.exited;
  expect(vi.getTimerCount()).toBe(0);
});
