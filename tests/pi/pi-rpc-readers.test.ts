import { afterEach, expect, test, vi } from "vitest";
import { piRpcCommandReader, piRpcModelLister, piRpcSkillReader } from "../../packages/oar/src/runtimes/pi/rpc/readers.js";
import { readPiRpc } from "../../packages/oar/src/runtimes/pi/rpc/read.js";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { orient } from "../../packages/oar/src/shared/orientation/index.js";
import { PiRpcVersionError } from "../../packages/oar/src/runtimes/pi/rpc/version.js";
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


test.each(["1.3.99", "private-native-secret"])("RPC version refusal keeps safe structured evidence: %s", async (version) => {
  vi.mocked(readPiRpc).mockRejectedValue(new PiRpcVersionError(version));
  const expected = { kind: "unsupported", code: "version_unsupported", requiredVersion: "1.4.0" };
  for (const reader of Object.values(readers)) {
    // oxlint-disable-next-line no-await-in-loop -- Exercise each public reader against the same failure.
    const result = await reader(installed);
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain("private-native-secret");
    if (version === "1.3.99") { expect(result).toHaveProperty("installedVersion", version); }
    else { expect(result).not.toHaveProperty("installedVersion"); }
  }
});

test("the default RPC entry reports its exact bundled requirement, not only the explicit-command floor", async () => {
  vi.mocked(readPiRpc).mockRejectedValue(new PiRpcVersionError("1.4.0", "1.5.2"));
  await expect(readers.models(installed)).resolves.toMatchObject({
    kind: "unsupported", code: "version_unsupported", installedVersion: "1.4.0", requiredVersion: "1.5.2",
  });
});
