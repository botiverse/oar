/* oxlint-disable eslint/max-statements -- Deadline tests deliberately advance and inspect a full native hook timeline. */
import { inspect } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { claudeOpenSettings } from "../../packages/oar/src/runtimes/claude/open-settings.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const DEFAULT_OPTIONS = { effort: "low" };

async function outcome(operation: Promise<void>): Promise<unknown> {
  try { await operation; return undefined; } catch (error) { return error; }
}

function setup(options: Partial<SessionOptions> = DEFAULT_OPTIONS) {
  const child = fakeLineProcess();
  const readback = claudeOpenSettings(child, { readbackMs: 2000, hookMs: 3000 });
  child.onExit((code) => { readback.exited(code); });
  const result = outcome(readback.confirm({ cwd: "/work", ...options }));
  return {
    child, readback, result,
    hook(subtype: string, id = "first", extra: JsonRecord = {}) {
      expect(readback.consume({
        type: "system", subtype, hook_id: id, hook_event: "SessionStart",
        hook_name: `SessionStart:${id}`, ...extra,
      })).toBe(false);
    },
    answer() {
      const request = asRecord(JSON.parse(child.written.at(-1) ?? "{}"));
      expect(readback.consume({
        type: "control_response",
        response: { subtype: "success", request_id: request?.request_id, response: { fast_mode_state: "off", applied: { effort: "low" } } },
      })).toBe(true);
    },
  };
}

test.each([
  { effort: "low" },
  { serviceTier: "default" },
  { resume: "saved" },
])("SessionStart pauses the opening readback for %j", async (options) => {
  const run = setup(options);
  await vi.advanceTimersByTimeAsync(500);
  run.hook("hook_started");
  await vi.advanceTimersByTimeAsync(2500);
  expect(run.child.killed()).toBe(false);
  run.hook("hook_response", "first", { outcome: "error", exit_code: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  run.answer();
  await expect(run.result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

test("the hook response resumes only the unused readback budget", async () => {
  const run = setup();
  await vi.advanceTimersByTimeAsync(1500);
  run.hook("hook_started");
  await vi.advanceTimersByTimeAsync(2500);
  run.hook("hook_response");
  await vi.advanceTimersByTimeAsync(499);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toMatchObject({ message: "claude did not answer get_settings within 2000 ms, so effort low cannot be confirmed" });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("overlapping hooks pause once, pair by hook_id, and repeated starts cannot extend the cap", async () => {
  const run = setup();
  run.hook("hook_started", "first", { uuid: "start-uuid", stdout: "private-output" });
  await vi.advanceTimersByTimeAsync(1000);
  run.hook("hook_started", "second");
  run.hook("hook_response", "unknown");
  await vi.advanceTimersByTimeAsync(1000);
  run.hook("hook_response", "first", { uuid: "different-response-uuid" });
  run.hook("hook_started", "second");
  await vi.advanceTimersByTimeAsync(999);
  expect(run.child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const error = await run.result;
  expect(error).toMatchObject({ message: "claude SessionStart hooks exceeded the 3000 ms opening pause budget while waiting for get_settings; still running: SessionStart:second, so effort low cannot be confirmed" });
  expect(inspect(error, { depth: null })).not.toContain("private-output");
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("the pause cap is shared across initialize and get_settings", async () => {
  const run = setup({ resume: "saved", effort: "low" });
  run.hook("hook_started");
  await vi.advanceTimersByTimeAsync(2000);
  run.hook("hook_response");
  run.answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(run.child.written).toHaveLength(2);
  run.hook("hook_started", "second");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await run.result).toMatchObject({ message: "claude SessionStart hooks exceeded the 3000 ms opening pause budget while waiting for get_settings; still running: SessionStart:second, so effort low cannot be confirmed" });
  expect(run.child.killed()).toBe(true);
});

test.each([
  { hook_event: "SessionEnd" },
  { parent_tool_use_id: "child-call" },
  { hook_id: null },
])("unrelated or unpairable hooks do not pause the deadline: %j", async (extra) => {
  const run = setup();
  run.hook("hook_started", "first", extra);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await run.result).toMatchObject({ message: "claude did not answer get_settings within 2000 ms, so effort low cannot be confirmed" });
  expect(run.child.killed()).toBe(true);
});

test("process exit interrupts a hook wait and clears all timers", async () => {
  const run = setup();
  run.hook("hook_started");
  run.child.end(1);
  expect(await run.result).toMatchObject({ message: "claude exited (code 1) before answering get_settings, so effort low cannot be confirmed" });
  expect(vi.getTimerCount()).toBe(0);
});

test("fast opens and later hooks leave no opening timers behind", async () => {
  const run = setup();
  run.answer();
  await expect(run.result).resolves.toBeUndefined();
  run.hook("hook_started");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(run.child.killed()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("a hook seen before confirm still consumes the same pause allowance", async () => {
  const child = fakeLineProcess();
  const readback = claudeOpenSettings(child, { readbackMs: 2000, hookMs: 3000 });
  readback.consume({ type: "system", subtype: "hook_started", hook_event: "SessionStart", hook_id: "early", hook_name: "SessionStart:startup" });
  await vi.advanceTimersByTimeAsync(1000);
  const result = outcome(readback.confirm({ cwd: "/work", effort: "low" }));
  await vi.advanceTimersByTimeAsync(1999);
  expect(child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ message: "claude SessionStart hooks exceeded the 3000 ms opening pause budget while waiting for get_settings; still running: SessionStart:startup, so effort low cannot be confirmed" });
  expect(child.killed()).toBe(true);
});

test("native initialization errors still win while hooks are running", async () => {
  const run = setup({ resume: "saved" });
  run.hook("hook_started");
  run.readback.consume({ type: "result", subtype: "error_during_execution", errors: ["native initialization failed"] });
  expect(await run.result).toMatchObject({ message: "native initialization failed" });
  expect(run.child.killed()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
