import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { CLAUDE_EFFORT_READBACK_MS } from "../../packages/oar/src/runtimes/claude/effort.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.293" } as const;
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });

function scripted(applied: Record<string, unknown>, error?: string): FakeLineProcess {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(JSON.parse(line));
    if (asRecord(request?.request)?.subtype !== "initialize") { return; }
    process.emit(`${JSON.stringify({ type: "control_response", response: error === undefined
      ? { subtype: "success", request_id: request?.request_id, response: applied }
      : { subtype: "error", request_id: request?.request_id, error } })}\n`);
  });
  spawnLineProcess.mockReturnValue(child);
  return child;
}

test.each([undefined, "old-id"])("per-process settings and initialization confirm fast before open (resume=%s)", async (resume) => {
  const child = scripted({ fast_mode_state: "on" });
  const session = await claudeSession(installation, { cwd: "/work", serviceTier: "fast", ...(resume === undefined ? {} : { resume }) });
  expect(spawnLineProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--settings", '{"fastMode":true}']));
  expect(session.serviceTier().value).toBe("fast");
  expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : [])).toContainEqual({ kind: "service_tier", serviceTier: "fast" });
  child.emit(`${JSON.stringify({ type: "system", subtype: "init", model: "opus", fast_mode_state: "cooldown" })}\n`);
  expect(session.serviceTier().value).toBe("default");
  child.emit(`${JSON.stringify({ type: "result", subtype: "success", fast_mode_state: "on" })}\n`);
  expect(session.serviceTier().value).toBe("fast");
  await session.dispose();
});

test("explicit default disables fast instead of inheriting user settings", async () => {
  scripted({ fast_mode_state: "off" });
  const session = await claudeSession(installation, { cwd: "/work", serviceTier: "default" });
  expect(spawnLineProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--settings", '{"fastMode":false}']));
  expect(session.serviceTier().value).toBe("default");
  await session.dispose();
});

test.each([
  { fast_mode_state: "off", fast_mode_disabled_reason: "unsupported_model" },
  { fast_mode_state: "cooldown" },
  { effective: { fastMode: true } },
])("configuration intent never substitutes for active fast mode: %o", async (applied) => {
  const child = scripted(applied);
  await expect(claudeSession(installation, { cwd: "/work", serviceTier: "fast" })).rejects.toThrow(/although serviceTier fast was requested/u);
  expect(child.killed()).toBe(true);
});

test("native control rejection names the requested tier and why it could not be confirmed", async () => {
  const child = scripted({}, "initialize rejected");
  await expect(claudeSession(installation, { cwd: "/work", serviceTier: "fast" })).rejects.toThrow(/unreported.*fast.*initialize rejected/u);
  expect(child.killed()).toBe(true);
});

test("unknown tier fails before starting claude", async () => {
  await expect(claudeSession(installation, { cwd: "/work", serviceTier: "priority" })).rejects.toThrow(/cannot apply serviceTier priority/u);
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("unanswered initialize is bounded and stops claude", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const opening = claudeSession(installation, { cwd: "/work", serviceTier: "fast" });
  const rejected = expect(opening).rejects.toThrow(/initialize.*serviceTier fast cannot be confirmed/u);
  // launch sweeps its filesystem before the timer is installed.
  await vi.waitFor(() => { expect(child.written).toHaveLength(1); });
  await vi.advanceTimersByTimeAsync(CLAUDE_EFFORT_READBACK_MS);
  await rejected;
  expect(child.killed()).toBe(true);
});
