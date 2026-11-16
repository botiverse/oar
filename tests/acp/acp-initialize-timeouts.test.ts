/* oxlint-disable import/max-dependencies -- Exercise the shared opening path with every built-in ACP profile. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { codebuddyAcpProfile } from "../../packages/oar/src/runtimes/codebuddy/session.js";
import { devinAcpProfile } from "../../packages/oar/src/runtimes/devin/session.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { AcpError } from "../../packages/oar/src/shared/acp/errors.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { sharedAcpSession } from "../../packages/oar/src/shared/acp/shared-session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "fake-acp" } as const;
const basic: AcpSessionProfile = {
  args: [], capabilities: { queue: { durable: false }, attribution: "opaque" }, selectAuthMethod: () => "login",
};

async function outcome(operation: Promise<unknown>): Promise<unknown> {
  try { return await operation; } catch (error) { return error; }
}
function setup(profile: AcpSessionProfile, heldMethods = ["initialize"], shared = false) {
  const child = fakeLineProcess();
  const calls: string[] = [];
  const held = new Map<string, JsonRecord>();
  const answer = (request: JsonRecord): void => {
    const results: Readonly<Record<string, JsonRecord>> = { initialize: { protocolVersion: 1 }, "session/new": { sessionId: "created" } };
    const result = results[String(request.method)] ?? {};
    child.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  };
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = asRecord(JSON.parse(line));
      if (request?.id !== undefined) {
        const method = String(request.method); calls.push(method);
        if (heldMethods.includes(method)) { held.set(method, request); } else { answer(request); }
      }
    }
  });
  spawnLineProcess.mockReturnValue(child);
  const start = shared ? sharedAcpSession(profile, {
    processCwd: options => options.cwd, associations: () => [], cleanup: async () => {}, diagnostic: () => {},
  }) : acpSession(profile);
  const result = outcome(start(installation, { cwd: process.cwd() }, { requested: "auto", placement: shared ? "shared" : "isolated" }));
  return { child, calls, result, answer: (method = "initialize") => { const request = held.get(method); expect(request).toBeDefined(); if (request !== undefined) { answer(request); } } };
}

const profiles = { grok: grokAcpProfile, kimi: kimiAcpProfile, antigravity: antigravityAcpProfile, codebuddy: codebuddyAcpProfile,
  devin: devinAcpProfile, opencode: opencodeAcpProfile, opencodeV2: opencodeV2AcpProfile };

test.each(Object.entries(profiles))("%s initialize waits 60 seconds independently of its ordinary request bound", async (_name, profile) => {
  const run = setup(profile);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(run.calls).toEqual(["initialize"]);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toBeInstanceOf(AcpError);
  expect(await run.result).toMatchObject({ kind: "timeout", method: "initialize", timeoutMs: 60_000, message: "ACP request initialize timed out after 60000ms" });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

// oxlint-disable-next-line eslint/max-statements -- Keep reply timing, successful open and timer cleanup in one lifecycle.
test.each([false, true])("a reply after 15 seconds still opens the session (shared=%s)", async shared => {
  const run = setup(basic, ["initialize"], shared);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(run.calls).toEqual(["initialize"]);
  expect(run.child.killed()).toBe(false);
  run.answer(); await vi.advanceTimersByTimeAsync(0);
  expect(await run.result).toHaveProperty("id", "created");
  expect(run.calls).toEqual(["initialize", "authenticate", "session/new"]);
  run.child.kill(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

// oxlint-disable-next-line eslint/max-statements -- Compare both sides of the next phase deadline after a slow initialize.
test.each(["authenticate", "session/new"])("%s has its own unchanged 15-second deadline after a slow initialize", async method => {
  const run = setup(basic, ["initialize", method]);
  await vi.advanceTimersByTimeAsync(20_000);
  run.answer(); await vi.advanceTimersByTimeAsync(0);
  expect(run.calls.at(-1)).toBe(method);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toMatchObject({ kind: "timeout", method, timeoutMs: 15_000 });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([25, 75_000])("a profile can override only initialize to %i ms", async timeoutMs => {
  const run = setup({ ...basic, requestTimeoutMs: 10, initializeTimeoutMs: timeoutMs });
  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toMatchObject({ kind: "timeout", method: "initialize", timeoutMs });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("shared initialization retains the typed deadline and cleans up", async () => {
  const run = setup(basic, ["initialize"], true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await run.result).toMatchObject({ name: "AcpError", kind: "timeout", method: "initialize", timeoutMs: 60_000 });
  expect(run.child.killed()).toBe(true);
  expect(run.calls).toEqual(["initialize"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("process exit still rejects initialize immediately and clears its deadline", async () => {
  const run = setup(basic);
  await vi.advanceTimersByTimeAsync(500);
  run.child.end(17); await vi.advanceTimersByTimeAsync(0);
  expect(await run.result).toMatchObject({ kind: "process_exited", exitCode: 17 });
  expect(run.calls).toEqual(["initialize"]);
  expect(vi.getTimerCount()).toBe(0);
});
