import { RequestError } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { afterEach, expect, test, vi } from "vitest";
import { kimiListModels, projectKimiModels } from "../../packages/oar/src/runtimes/kimi/list-models.js";

const acp = vi.hoisted(() => ({
  kill: vi.fn<() => void>(),
  request: vi.fn<(
    method: string,
    params?: unknown,
    options?: unknown,
  ) => Promise<unknown>>(),
}));

vi.mock("../../packages/oar/src/shared/acp/process.js", () => ({
  startAcpProcess: vi.fn(() => ({
    connection: { agent: { request: acp.request } },
    spawned: Promise.resolve(),
    exited: Promise.resolve(0),
    closed: false,
    exitCode: null,
    kill: acp.kill,
  })),
  // oxlint-disable-next-line eslint/max-params -- Mirrors the production deadline wrapper signature.
  withAcpDeadline: vi.fn(async (
    _runtime: unknown,
    _method: string,
    _timeoutMs: number | null,
    send: () => Promise<unknown>,
  ) => send()),
}));

const installation = { kind: "available", via: "executable", command: "kimi", version: "0.41.0" } as const;

// Shape from kimi-code packages/acp-server/src/config-options.ts (f9ca33376).
const newSessionResponse = {
  sessionId: "sess-1",
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "kimi-for-coding",
      options: [
        { value: "kimi-for-coding", name: "Kimi For Coding" },
        { value: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo" },
        { value: " ", name: "blank id is dropped" },
      ],
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: "high",
      options: [
        { value: "off", name: "Thinking off" },
        { value: "low", name: "Thinking low" },
        { value: "high", name: "Thinking high" },
      ],
    },
    { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: "default", options: [] },
  ],
  modes: { currentModeId: "default", availableModes: [] },
};

afterEach(() => {
  acp.kill.mockReset();
  acp.request.mockReset();
});

test("kimi projection lists the model option and attaches thinking levels to the current model only", () => {
  expect(projectKimiModels(newSessionResponse)).toEqual([
    { id: "kimi-for-coding", displayName: "Kimi For Coding", effortLevels: ["low", "high"], defaultEffort: "high" },
    { id: "kimi-k2-turbo-preview", displayName: "Kimi K2 Turbo" },
  ]);
});

test("kimi projection treats thinking off as no default and omits levels without a thinking option", () => {
  const [model, thinking] = newSessionResponse.configOptions;
  expect(projectKimiModels({ configOptions: [model, { ...thinking, currentValue: "off" }] })).toEqual([
    { id: "kimi-for-coding", displayName: "Kimi For Coding", effortLevels: ["low", "high"] },
    { id: "kimi-k2-turbo-preview", displayName: "Kimi K2 Turbo" },
  ]);
  expect(projectKimiModels({ configOptions: [model] })).toEqual([
    { id: "kimi-for-coding", displayName: "Kimi For Coding" },
    { id: "kimi-k2-turbo-preview", displayName: "Kimi K2 Turbo" },
  ]);
  expect(projectKimiModels({ configOptions: [] })).toBeUndefined();
  expect(projectKimiModels(null)).toBeUndefined();
});

test("kimi lister initializes, authenticates with login, opens and closes a session", async () => {
  acp.request.mockImplementation(async (method) => {
    switch (method) {
      case "initialize":
        return { authMethods: [{ id: "login" }] };
      case "authenticate":
        return {};
      case "session/new":
        return newSessionResponse;
      case "session/close":
        return {};
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  await expect(kimiListModels(installation)).resolves.toEqual({
    kind: "ok",
    models: [
      { id: "kimi-for-coding", displayName: "Kimi For Coding", effortLevels: ["low", "high"], defaultEffort: "high" },
      { id: "kimi-k2-turbo-preview", displayName: "Kimi K2 Turbo" },
    ],
  });
  expect(acp.request.mock.calls.map(([method]) => method)).toEqual([
    "initialize",
    "authenticate",
    "session/new",
    "session/close",
  ]);
  expect(acp.request.mock.calls[1]?.[1]).toEqual({ methodId: "login" });
  expect(acp.request.mock.calls[3]?.[1]).toEqual({ sessionId: "sess-1" });
  expect(acp.kill).toHaveBeenCalledOnce();
});

test("kimi lister still returns the list when session/close fails", async () => {
  acp.request.mockImplementation(async (method) => {
    switch (method) {
      case "initialize":
        return { authMethods: [] };
      case "session/new":
        return newSessionResponse;
      case "session/close":
        throw new RequestError(-32_601, "Method not found");
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  await expect(kimiListModels(installation)).resolves.toMatchObject({ kind: "ok" });
  expect(acp.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "session/new", "session/close"]);
});

test("kimi lister maps a session/new auth failure to unauthenticated", async () => {
  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return { authMethods: [{ id: "login" }] };
    }
    throw new RequestError(-32_000, "Authentication required");
  });
  await expect(kimiListModels(installation)).resolves.toEqual({
    kind: "unauthenticated",
    detail: "Authentication required",
  });
  expect(acp.kill).toHaveBeenCalledOnce();
});

test("kimi lister maps method-not-found and a missing model option to unsupported", async () => {
  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return { authMethods: [] };
    }
    throw new RequestError(-32_601, "Method not found");
  });
  await expect(kimiListModels(installation)).resolves.toMatchObject({ kind: "unsupported" });

  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return { authMethods: [] };
    }
    return { sessionId: "sess-2", configOptions: [], modes: {} };
  });
  await expect(kimiListModels(installation)).resolves.toEqual({
    kind: "unsupported",
    reason: "this kimi build returns no model config option on session/new",
  });
});

test("kimi lister wraps unexpected failures", async () => {
  acp.request.mockImplementation(async () => {
    throw new Error("boom");
  });
  await expect(kimiListModels(installation)).rejects.toThrow("Failed to list Kimi models");
  expect(acp.kill).toHaveBeenCalledOnce();
});
