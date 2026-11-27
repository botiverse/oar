/* oxlint-disable max-statements -- Verifies reader routing and strict executable/bundled matching across Pi RPC entry points. */
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeRegistry } from "../../packages/oar/src/registry.js";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { openPiRpc } from "../../packages/oar/src/runtimes/pi/rpc/open.js";
import { readPiRpc } from "../../packages/oar/src/runtimes/pi/rpc/read.js";
import { orient } from "../../packages/oar/src/shared/orientation/index.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const mocks = vi.hoisted(() => ({
  sdkTools: vi.fn(async () => ({ kind: "ok", items: [{ name: "sdk-tool", description: "sdk", active: true }] })),
  sdkSkills: vi.fn(async () => ({ kind: "ok", partial: false, items: [] })),
  sdkCommands: vi.fn(async () => ({ kind: "ok", partial: false, items: [] })),
  sdkModels: vi.fn(async () => ({ kind: "ok", models: [] })),
  openPiRpc: vi.fn(),
  readPiRpc: vi.fn(),
}));

vi.mock("../../packages/oar/src/runtimes/pi/inventory.js", () => ({
  createPiInventories: () => ({ tools: mocks.sdkTools, skills: mocks.sdkSkills, commands: mocks.sdkCommands }),
}));
vi.mock("../../packages/oar/src/runtimes/pi/list-models.js", async (original) => ({
  ...await original<object>(),
  piModelLister: () => mocks.sdkModels,
}));
vi.mock("../../packages/oar/src/runtimes/pi/rpc/open.js", async (original) => ({
  ...await original<object>(),
  openPiRpc: mocks.openPiRpc,
}));
vi.mock("../../packages/oar/src/runtimes/pi/rpc/read.js", async (original) => ({
  ...await original<object>(),
  readPiRpc: mocks.readPiRpc,
}));
vi.mock("../../packages/oar/src/runtimes/pi/installation.js", async (original) => ({
  ...await original<object>(),
  piInstallationFor: () => async () => ({ kind: "available", via: "executable", command: "/opt/bin/resolved-pi", version: "1.6.1" }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const bundled = { kind: "available", via: "bundled" } as const;
const executable = { kind: "available", via: "executable", command: "/opt/bin/resolved-pi", version: "1.6.1" } as const;

test("explicit-command runtime routes skills, commands, and listModels directly through RPC without host SDK fallback", async () => {
  vi.mocked(readPiRpc).mockImplementation(async (_runtime, _options, read) => read({
    child: fakeLineProcess(),
    directory: { path: "/fixture", remove() {} },
    state: {
      sessionId: "rpc", thinkingLevel: "off", isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    },
    control: {
      request: async (command): Promise<RpcResponse> => command.type === "get_commands"
        ? {
            id: "1", type: "response", command: "get_commands", success: true, data: {
              commands: [
                { name: "ext-cmd", description: "External", source: "extension", sourceInfo: { path: "/tmp/ext.ts", source: "user", scope: "user", origin: "top-level" } },
                { name: "skill:ext-skill", description: "Skill", source: "skill", sourceInfo: { path: "/tmp/s", source: "user", scope: "user", origin: "top-level" } },
              ],
            },
          }
        : { id: "2", type: "response", command: "get_available_models", success: true, data: { models: [] } },
    },
  }));

  const runtime = createPiRuntime({ execution: "subprocess", command: "pi" });
  const commands = await runtime.commands(executable);
  const skills = await runtime.skills(executable);
  const models = await runtime.listModels(executable);

  expect(commands).toMatchObject({ kind: "ok", items: [{ name: "ext-cmd", source: "extension" }] });
  expect(skills).toMatchObject({ kind: "ok", items: [{ name: "ext-skill" }] });
  expect(models).toEqual({ kind: "ok", models: [] });

  expect(mocks.sdkCommands).not.toHaveBeenCalled();
  expect(mocks.sdkSkills).not.toHaveBeenCalled();
  expect(mocks.sdkModels).not.toHaveBeenCalled();

  expect(vi.mocked(readPiRpc)).toHaveBeenCalledTimes(3);
  for (const call of vi.mocked(readPiRpc).mock.calls) {
    expect(call[0]).toMatchObject({ execution: "subprocess", command: "/opt/bin/resolved-pi" });
  }
});

test("explicit-command runtime returns unsupported for tools and never calls host SDK tools reader", async () => {
  const runtime = createPiRuntime({ execution: "subprocess", command: "pi" });
  await expect(runtime.tools(executable)).resolves.toEqual({
    kind: "unsupported",
    code: "installation_unsupported",
    reason: "Pi RPC with an explicit command has no native tools query",
  });
  await expect(runtime.tools(executable, { env: { OAR_PI_READER_CHANGED: "child" } })).resolves.toEqual({
    kind: "unsupported",
    code: "installation_unsupported",
    reason: "Pi RPC with an explicit command has no native tools query",
  });
  expect(mocks.sdkTools).not.toHaveBeenCalled();
});

test("explicit-command RPC rejects via: bundled, and bundled RPC rejects via: executable", async () => {
  const explicit = createPiRuntime({ execution: "subprocess", command: "pi" });
  await expect(explicit.commands(bundled)).resolves.toEqual({
    kind: "unsupported",
    code: "installation_unsupported",
    reason: "Pi RPC with an explicit command requires an executable installation",
  });
  await expect(explicit.listModels(bundled)).resolves.toEqual({
    kind: "unsupported",
    reason: "Pi RPC with an explicit command requires an executable installation",
  });
  await expect(explicit.session(bundled, { cwd: "/work" })).rejects.toThrow(
    "Pi RPC with an explicit command requires an executable installation",
  );

  const bundledOnly = createPiRuntime({ execution: "subprocess" });
  await expect(bundledOnly.commands(executable, { env: { OAR_PI_FORCE_RPC_TEST: "1" } })).resolves.toEqual({
    kind: "unsupported",
    code: "installation_unsupported",
    reason: "Pi RPC needs the bundled SDK installation",
  });
  await expect(bundledOnly.listModels(executable, { env: { OAR_PI_FORCE_RPC_TEST: "1" } })).resolves.toEqual({
    kind: "unsupported",
    reason: "Pi RPC needs the bundled SDK installation",
  });
  await expect(bundledOnly.session(executable, { cwd: "/work" })).rejects.toThrow(
    "Pi RPC needs the bundled SDK installation",
  );
  expect(mocks.readPiRpc).not.toHaveBeenCalled();
  expect(mocks.openPiRpc).not.toHaveBeenCalled();
});

test("explicit-command session forwards installation.command and runtime args to openPiRpc", async () => {
  vi.mocked(openPiRpc).mockRejectedValue(new Error("stop-after-open-check"));
  const runtime = createPiRuntime({ execution: "subprocess", command: "host-wrapper", args: ["pi"] });
  await expect(runtime.session(executable, { cwd: "/work" })).rejects.toThrow("stop-after-open-check");
  expect(vi.mocked(openPiRpc)).toHaveBeenCalledWith(
    { cwd: "/work" },
    expect.anything(),
    expect.any(Function),
    expect.objectContaining({ execution: "subprocess", command: "/opt/bin/resolved-pi", args: ["pi"] }),
  );
});

test("only standalone command: pi exposes installPlan, install, checkUpdate, and upgrade", () => {
  const inProcess = createPiRuntime();
  const bundledRpc = createPiRuntime({ execution: "subprocess" });
  const customPath = createPiRuntime({ execution: "subprocess", command: "/opt/bin/pi" });
  const wrapper = createPiRuntime({ execution: "subprocess", command: "pi", args: ["sub"] });
  const standalone = createPiRuntime({ execution: "subprocess", command: "pi" });

  for (const runtime of [inProcess, bundledRpc, customPath, wrapper]) {
    expect(runtime.installPlan).toBeUndefined();
    expect(runtime.install).toBeUndefined();
    expect(runtime.checkUpdate).toBeUndefined();
    expect(runtime.upgrade).toBeUndefined();
  }
  expect(standalone.installPlan).toBeDefined();
  expect(standalone.install).toBeDefined();
  expect(standalone.checkUpdate).toBeDefined();
  expect(standalone.upgrade).toBeDefined();
});

test("explicit-command RPC readers fast-refuse supplied unsupported versions before spawning", async () => {
  const runtime = createPiRuntime({ execution: "subprocess", command: "pi" });
  for (const installedVersion of ["1.3.99", "1.6.1-rc.1"]) {
    const stale = { kind: "available", via: "executable", command: "/opt/bin/old-pi", version: installedVersion } as const;
    const expected = { kind: "unsupported", code: "version_unsupported", installedVersion, requiredVersion: "1.4.0" };
    // oxlint-disable-next-line no-await-in-loop -- Check each invalid version independently across readers.
    await expect(runtime.commands(stale)).resolves.toMatchObject(expected);
    // oxlint-disable-next-line no-await-in-loop -- Check each invalid version independently across readers.
    await expect(runtime.skills(stale)).resolves.toMatchObject(expected);
    // oxlint-disable-next-line no-await-in-loop -- Check each invalid version independently across readers.
    await expect(runtime.listModels(stale)).resolves.toMatchObject(expected);
  }
  expect(mocks.readPiRpc).not.toHaveBeenCalled();
});

test("orient completes with changed env on explicit-command Pi without tools or host SDK fallback", async () => {
  vi.mocked(readPiRpc).mockImplementation(async (_runtime, _options, read) => read({
    child: fakeLineProcess(),
    directory: { path: "/fixture", remove() {} },
    state: {
      sessionId: "rpc", thinkingLevel: "off", isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    },
    control: {
      request: async (command): Promise<RpcResponse> => command.type === "get_commands"
        ? {
            id: "1", type: "response", command: "get_commands", success: true, data: {
              commands: [
                { name: "ext-cmd", description: "External", source: "extension", sourceInfo: { path: "/tmp/ext.ts", source: "user", scope: "user", origin: "top-level" } },
                { name: "skill:ext-skill", description: "Skill", source: "skill", sourceInfo: { path: "/tmp/s", source: "user", scope: "user", origin: "top-level" } },
              ],
            },
          }
        : { id: "2", type: "response", command: "get_available_models", success: true, data: { models: [] } },
    },
  }));

  const runtime = createPiRuntime({ execution: "subprocess", command: "pi" });
  const report = await orient(new RuntimeRegistry([runtime]), {
    depth: "models",
    include: ["customization"],
    env: { OAR_PI_READER_CHANGED: "child" },
  });
  expect(report.runtimes[0]).toMatchObject({
    id: "pi",
    installation: { kind: "ok", value: { kind: "available", via: "executable", command: "/opt/bin/resolved-pi", version: "1.6.1" } },
    providers: { kind: "unsupported" },
    models: { kind: "ok", value: [] },
    customization: { kind: "ok", value: { skills: 1 } },
  });
});
