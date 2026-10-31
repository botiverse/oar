import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { opencodePreparation } from "../sea-trial/harness/opencode-home.js";
import { acpBackend } from "../sea-trial/harness/acp-backends.js";

const mocks = vi.hoisted(() => ({ session: vi.fn(), start: vi.fn(), record: vi.fn() }));
vi.mock("../packages/oar/src/runtimes/opencode/session.js", () => ({ opencodeSession: mocks.session }));
vi.mock("../sea-trial/harness/trace.js", () => ({ record: mocks.record }));
vi.mock("../sea-trial/harness/aimock-acp.js", () => ({
  startOpencodeAimock: mocks.start, startGrokAimock: mocks.start,
  startKimiAimock: mocks.start, startAntigravityAimock: mocks.start,
}));
afterEach(() => { vi.resetAllMocks(); });

const installation = { kind: "available", via: "executable", command: "/pinned/opencode", version: "1.19.5" } as const;
const env = { HOME: "/fixture/home", XDG_DATA_HOME: "/fixture/data" };

// oxlint-disable-next-line max-statements -- Verify both sides of the open and exit barriers before releasing callers.
test("the backend prepares its fixture once and waits for open AND exit before releasing callers", async () => {
  const opened = Promise.withResolvers<{ dispose: () => Promise<void> }>();
  const exited = Promise.withResolvers<void>();
  const dispose = vi.fn(async () => { await exited.promise; });
  mocks.start.mockResolvedValue({ env });
  mocks.session.mockReturnValue(opened.promise);
  const backend = await acpBackend("opencode");
  const prepare = backend.beforeSuite;
  assert.ok(prepare !== undefined);
  const completed = vi.fn();
  async function run() { await prepare?.(installation); completed(); }
  const first = run();
  const second = run();
  expect(mocks.session).toHaveBeenCalledExactlyOnceWith(installation, { cwd: env.HOME, env });
  expect(completed).not.toHaveBeenCalled();
  opened.resolve({ dispose });
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce(); });
  expect(completed).not.toHaveBeenCalled();
  exited.resolve();
  await Promise.all([first, second]);
  await prepare(installation);
  expect(mocks.session).toHaveBeenCalledOnce();
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ready", dataDirectory: env.XDG_DATA_HOME }));
});

test.each(["open", "dispose"])("a failed %s preserves the native error and is not silently retried", async (phase) => {
  const error = new Error("native startup: database is locked");
  if (phase === "open") { mocks.session.mockRejectedValue(error); }
  else { mocks.session.mockResolvedValue({ dispose: async () => { throw error; } }); }
  const prepare = opencodePreparation(env);
  await expect(prepare(installation)).rejects.toBe(error);
  await expect(prepare(installation)).rejects.toBe(error);
  expect(mocks.session).toHaveBeenCalledOnce();
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", error: error.message }));
});

test("each new data directory is prepared independently; other ACP backends are unchanged", async () => {
  mocks.session.mockResolvedValue({ dispose: async () => {} });
  await opencodePreparation(env)(installation);
  const other = { HOME: "/other/home", XDG_DATA_HOME: "/other/data" };
  await opencodePreparation(other)(installation);
  expect(mocks.session).toHaveBeenNthCalledWith(2, installation, { cwd: other.HOME, env: other });
  mocks.start.mockResolvedValue({ env });
  const grok = await acpBackend("grok");
  expect(grok.beforeSuite).toBeUndefined();
});
