import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import type { JsonRecord } from "../packages/oar/src/shared/json.js";
import { warmCodexHome } from "../sea-trial/harness/codex-home.js";

const mocks = vi.hoisted(() => ({ codexInstallation: vi.fn(), startAppServerClient: vi.fn() }));
vi.mock("../packages/oar/src/runtimes/codex/installation.js", () => ({ codexInstallation: mocks.codexInstallation }));
vi.mock("../packages/oar/src/runtimes/codex/app-server-client.js", () => ({ startAppServerClient: mocks.startAppServerClient }));
beforeEach(() => {
  vi.useFakeTimers();
  mocks.codexInstallation.mockResolvedValue({ kind: "available", via: "executable", command: "/pinned/codex" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

function nativeClient() {
  const ready = Promise.withResolvers<JsonRecord>();
  const exited = Promise.withResolvers<number | null>();
  const failure = new Error("app-server exited: exit code 1; signal none; sqlite initialization failed");
  const client = {
    spawned: Promise.resolve(), exited: exited.promise,
    request: vi.fn(async () => { const value = await ready.promise; return value; }), notify: vi.fn(() => {}),
    handle: vi.fn(() => {}), mark: vi.fn(() => {}), onExit: vi.fn(() => {}),
    kill: vi.fn(() => { ready.reject(failure); exited.resolve(null); }),
  } satisfies AppServerClient;
  mocks.startAppServerClient.mockReturnValue(client);
  return { ready, exited, client, failure };
}

async function pendingWarmup() {
  const native = nativeClient();
  native.client.kill.mockImplementation(() => {});
  const completed = vi.fn();
  async function run() { await warmCodexHome({ CODEX_HOME: "/fresh/home" }); completed(); }
  const warmup = run();
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).not.toHaveBeenCalled();
  expect(native.client.kill).not.toHaveBeenCalled();
  return { ...native, completed, warmup };
}

test("warmup waits for initialization and process exit", async () => {
  const { ready, exited, client, completed, warmup } = await pendingWarmup();
  ready.resolve({});
  await vi.advanceTimersByTimeAsync(0);
  expect(client.kill).toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  exited.resolve(0);
  await warmup;
  expect(completed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("warmup uses the installation-selected binary and session environment", async () => {
  const { ready } = nativeClient();
  const warmup = warmCodexHome({ CODEX_HOME: "/fresh/home" });
  ready.resolve({});
  await warmup;
  expect(mocks.codexInstallation).toHaveBeenCalledOnce();
  expect(mocks.startAppServerClient).toHaveBeenCalledWith("/pinned/codex", { CODEX_HOME: "/fresh/home" });
});

test("a failed initialization prevents warmup from reporting success", async () => {
  const { ready, client, failure } = nativeClient();
  const result = expect(warmCodexHome({ CODEX_HOME: "/fresh/home" })).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(0);
  ready.reject(failure);
  await result;
  expect(client.kill).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
