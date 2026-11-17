/* oxlint-disable import/max-dependencies -- Exercise native transport ordering with the real OpenCode profiles. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawn = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess: spawn }));
const children: FakeLineProcess[] = [];
const requests: { child: FakeLineProcess; request: JsonRecord }[] = [];
const installation = { kind: "available", via: "executable", command: "fake-opencode", version: "1.19.5" } as const;
const options = () => ({ cwd: process.cwd(), env: { XDG_DATA_HOME: join(tmpdir(), `oar-gate-${randomUUID()}`) } });
beforeEach(() => {
  spawn.mockImplementation(() => {
    const child = fakeLineProcess(); children.push(child);
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        const request = asRecord(JSON.parse(line));
        if (request?.id !== undefined) { requests.push({ child, request }); }
      }
    });
    return child;
  });
});
afterEach(() => { vi.useRealTimers(); for (const child of children) { child.end(0); } children.length = 0; requests.length = 0; spawn.mockReset(); });
function answer(index: number, method: string, result: JsonRecord): void {
  const entry = requests.find(row => row.child === children[index] && row.request.method === method);
  expect(entry).toBeDefined();
  if (entry !== undefined) { entry.child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: entry.request.id, result })}\n`); }
}
const initialized = { protocolVersion: 1, agentCapabilities: {} };
const tick = async (): Promise<void> => { await setImmediate(); };

// oxlint-disable-next-line eslint/max-statements -- Keep both phase boundaries visible in this concurrency regression.
test.each([opencodeAcpProfile, opencodeV2AcpProfile])("same-directory startup waits only until initialize, not session/new or disposal", async profile => {
  const open = acpSession(profile); const config = options();
  const first = open(installation, config);
  void Promise.allSettled([first]);
  await expect.poll(() => requests.length).toBe(1);
  const second = open(installation, config);
  void Promise.allSettled([second]);
  await tick();
  expect(spawn).toHaveBeenCalledTimes(1);
  answer(0, "initialize", initialized);
  await expect.poll(() => spawn.mock.calls.length).toBe(2);
  expect(children[0]?.killed()).toBe(false);
  answer(1, "initialize", initialized);
  await expect.poll(() => requests.filter(row => row.request.method === "session/new").length).toBe(2);
  answer(0, "session/new", { sessionId: "a" }); answer(1, "session/new", { sessionId: "b" });
  const sessions = await Promise.all([first, second]);
  await Promise.all(sessions.map(async session => { await session.dispose(); }));
});

test("different data directories initialize concurrently", async () => {
  const open = acpSession(opencodeAcpProfile);
  const pending = Promise.allSettled([open(installation, options()), open(installation, options())]);
  await expect.poll(() => requests.length).toBe(2);
  expect(spawn).toHaveBeenCalledTimes(2);
  for (const child of children) { child.end(1); }
  const results = await pending;
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
});

// oxlint-disable-next-line eslint/max-statements -- Failure, successor startup and cleanup are one ownership test.
test.each(["exit", "RPC error"])("a failed start (%s) releases its gate without a retry", async failure => {
  const open = acpSession(opencodeAcpProfile); const config = options();
  const first = Promise.allSettled([open(installation, config)]);
  await expect.poll(() => requests.length).toBe(1);
  const second = Promise.allSettled([open(installation, config)]);
  await tick(); expect(spawn).toHaveBeenCalledTimes(1);
  if (failure === "exit") { children[0]?.end(17); }
  else {
    const entry = requests.find(row => row.child === children[0] && row.request.method === "initialize");
    children[0]?.emit(`${JSON.stringify({ jsonrpc: "2.0", id: entry?.request.id, error: { code: -32_603, message: "database is locked" } })}\n`);
  }
  expect(await first).toMatchObject([{ status: "rejected" }]);
  await expect.poll(() => spawn.mock.calls.length).toBe(2);
  children[1]?.end(18);
  expect(await second).toMatchObject([{ status: "rejected" }]);
  expect(spawn).toHaveBeenCalledTimes(2);
});


// oxlint-disable-next-line eslint/max-statements -- The original 60-second deadline spans queue and native initialization.
test("20 seconds in the queue leaves only 40 seconds to initialize", async () => {
  vi.useFakeTimers();
  const open = acpSession(opencodeAcpProfile); const config = options();
  const first = Promise.allSettled([open(installation, config)]);
  await vi.advanceTimersByTimeAsync(0);
  const second = Promise.allSettled([open(installation, config)]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(spawn).toHaveBeenCalledTimes(1);
  answer(0, "initialize", initialized); await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledTimes(2);
  answer(0, "session/new", { sessionId: "owner" }); await first;
  await vi.advanceTimersByTimeAsync(39_999);
  expect(children[1]?.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await second).toMatchObject([{ status: "rejected", reason: { kind: "timeout", method: "initialize", timeoutMs: 60_000 } }]);
  expect(children[1]?.killed()).toBe(true);
});
