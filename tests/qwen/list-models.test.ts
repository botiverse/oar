import { afterEach, expect, test, vi } from "vitest";
import { qwenListModels } from "../../packages/oar/src/runtimes/qwen/list-models.js";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

vi.mock("../../packages/oar/src/runtimes/qwen/launch.js", () => ({ launchQwen: vi.fn() }));
const installation = { kind: "available" as const, via: "executable" as const, command: "qwen", version: "0.26.0" };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); });

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
  const listing = qwenListModels(installation);
  const result = expect(listing).resolves.toEqual({ kind: "ok", models: [{ id: "native" }] });
  await vi.advanceTimersByTimeAsync(16_001);
  await result;
  expect(launchQwen).toHaveBeenCalledTimes(1);
  expect(await child.exited).toBe(0);
});

test("an explicit short bound fails and releases an unresponsive native process", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess();
  vi.mocked(launchQwen).mockResolvedValue(child);
  const result = expect(qwenListModels(installation, { timeoutMs: 10 })).rejects.toThrow("initialize within 10 ms");
  await vi.advanceTimersByTimeAsync(5010);
  await result;
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.killed()).toBe(true);
  expect(launchQwen).toHaveBeenCalledTimes(1);
});
