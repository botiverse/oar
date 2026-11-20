import { afterEach, expect, test, vi } from "vitest";
import { qwenListModels } from "../../packages/oar/src/runtimes/qwen/list-models.js";
import { KILL_GRACE_MS } from "../../packages/oar/src/shared/executable/process-signals.js";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

vi.mock("../../packages/oar/src/runtimes/qwen/launch.js", () => ({ launchQwen: vi.fn() }));
const installation = { kind: "available" as const, via: "executable" as const, command: "qwen", version: "0.26.0" };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); });

// oxlint-disable-next-line max-statements -- Verify native query, cleanup and environment at the same boundary.
test("model listing tolerates the observed 16-second startup without retrying", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line));
    const request = asRecord(frame?.request);
    setTimeout(() => { process.emit(`${JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: frame?.request_id,
      response: request?.subtype === "get_available_models" ? { models: [{ id: "native" }] } : {},
    } })}\n`); }, request?.subtype === "initialize" ? 16_000 : 1);
  });
  child.stdin.on("finish", () => { child.end(0); });
  vi.mocked(launchQwen).mockResolvedValue(child);
  const env = { HOME: "qwen-home", OAR_READER_REMOVED: null };
  const listing = qwenListModels(installation, { env });
  const result = expect(listing).resolves.toEqual({ kind: "ok", models: [{ id: "native" }] });
  await vi.advanceTimersByTimeAsync(16_001);
  await result;
  expect(launchQwen).toHaveBeenCalledTimes(1);
  expect(launchQwen).toHaveBeenCalledWith("qwen", expect.any(String), expect.objectContaining({ env }));
  expect(await child.exited).toBe(0);
});

test("an explicit short bound fails and releases an unresponsive native process", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess(undefined, { ignoreEof: true });
  vi.mocked(launchQwen).mockResolvedValue(child);
  const result = expect(qwenListModels(installation, { timeoutMs: 10 })).rejects.toThrow("Qwen model listing timed out");
  await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 10);
  await result;
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.killed()).toBe(true);
  expect(launchQwen).toHaveBeenCalledTimes(1);
});

const nativeNoAuth = {
  type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0,
  error: { message: "No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode." },
};

test("native startup authentication refusal returns the model-list result and closes once", async () => {
  const child = fakeLineProcess((_line, process) => {
    process.emit(`${JSON.stringify(nativeNoAuth)}\n`);
  }, { ignoreEof: true });
  child.stdin.on("finish", () => { expect(child.killed()).toBe(false); child.end(1); });
  vi.mocked(launchQwen).mockResolvedValue(child);
  expect(await qwenListModels(installation)).toEqual({ kind: "unauthenticated", detail: "Configure a Qwen authentication type before listing models." });
  expect(child.written).toHaveLength(1);
  expect(child.stdin.writableEnded).toBe(true);
  expect(await child.exited).toBe(1);
  expect(launchQwen).toHaveBeenCalledTimes(1);
});

test.each([
  { ...nativeNoAuth, error: { message: "Extension store is busy" } },
  { ...nativeNoAuth, type: "assistant" },
  { ...nativeNoAuth, is_error: false },
  { ...nativeNoAuth, num_turns: 1 },
  { ...nativeNoAuth, parent_tool_use_id: "child" },
])("does not classify an unrelated native frame as signed out: %j", async frame => {
  const child = fakeLineProcess((_line, process) => {
    process.emit(`${JSON.stringify(frame)}\n`);
    process.end(1);
  });
  vi.mocked(launchQwen).mockResolvedValue(child);
  await expect(qwenListModels(installation)).rejects.toThrow("Qwen exited before answering a control request");
  expect(child.stdin.writableEnded).toBe(true);
});

test("an empty native catalog remains a successful model list", async () => {
  const child = fakeLineProcess((line, process) => {
    const frame = asRecord(parseJson(line));
    process.emit(`${JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: frame?.request_id, response: { models: [] },
    } })}\n`);
  });
  child.stdin.on("finish", () => { child.end(0); });
  vi.mocked(launchQwen).mockResolvedValue(child);
  expect(await qwenListModels(installation)).toEqual({ kind: "ok", models: [] });
  expect(child.written).toHaveLength(2);
});
