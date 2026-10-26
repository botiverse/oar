import { afterEach, expect, test, vi } from "vitest";
import { piRpcCommandReader, piRpcModelLister, piRpcSkillReader } from "../../packages/oar/src/runtimes/pi/rpc/readers.js";
import { readPiRpc } from "../../packages/oar/src/runtimes/pi/rpc/read.js";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { orient } from "../../packages/oar/src/shared/orientation/index.js";
import { RuntimeRegistry } from "../../packages/oar/src/registry.js";

vi.mock("../../packages/oar/src/runtimes/pi/rpc/read.js", async (original) => ({ ...await original<object>(), readPiRpc: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const installed = { kind: "available", via: "bundled" } as const;
const readers = { commands: piRpcCommandReader({ execution: "subprocess" }), skills: piRpcSkillReader({ execution: "subprocess" }), models: piRpcModelLister({ execution: "subprocess" }) };

test.each([new Error("private-native-secret"), new RangeError("private-native-secret")])("native errors of any class stay out of reader results (%s)", async (failure) => {
  vi.mocked(readPiRpc).mockRejectedValue(failure);
  await expect(readers.commands(installed)).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
  await expect(readers.skills(installed)).resolves.toEqual({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
  await expect(readers.models(installed)).rejects.toThrow(new Error("Pi RPC could not list available models"));
});

test.each([0, -1, NaN, Infinity])("invalid timeout %s refuses before native startup", async (timeoutMs) => {
  await expect(readers.commands(installed, { timeoutMs })).rejects.toThrow(RangeError);
  await expect(readers.models(installed, { timeoutMs })).rejects.toThrow(RangeError);
  expect(readPiRpc).not.toHaveBeenCalled();
});

test("the native deadline remains distinct from a query failure", async () => {
  vi.mocked(readPiRpc).mockRejectedValue(new DOMException("private-native-secret", "TimeoutError"));
  await expect(readers.commands(installed)).resolves.toEqual({ kind: "unavailable", code: "timeout", reason: "Native inventory query timed out" });
  await expect(readers.models(installed)).rejects.toThrow(new Error("Pi RPC model listing timed out"));
});

test.each([new Error("private-native-secret"), new DOMException("private-native-secret", "TimeoutError")])("orient records a Pi RPC model failure as failed, not unsupported (%s)", async (failure) => {
  vi.stubEnv("OAR_PI_READER_CHANGED", "host");
  vi.mocked(readPiRpc).mockRejectedValue(failure);
  const report = await orient(new RuntimeRegistry([createPiRuntime({ execution: "subprocess" })]), {
    depth: "models", env: { OAR_PI_READER_CHANGED: "child" },
  });
  expect(readPiRpc).toHaveBeenCalledOnce();
  expect(report.runtimes[0]?.models).toMatchObject({ kind: "failed", reason: "The runtime query failed" });
  expect(JSON.stringify(report)).not.toContain("private-native-secret");
});
