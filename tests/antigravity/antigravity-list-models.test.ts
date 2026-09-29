import { RequestError } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { afterEach, expect, test, vi } from "vitest";
import {
  antigravityListModels,
  projectAntigravityModels,
} from "../../packages/oar/src/runtimes/antigravity/list-models.js";

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

afterEach(() => {
  vi.clearAllMocks();
});

const installation = { kind: "available", via: "executable", command: "agy_acp_server", version: "1.2.1" } as const;

// Trimmed from a live agy_acp_server 1.2.1 `session/new` answer: effort is
// part of the model id and there is no thought_level option.
const newSessionResponse = {
  sessionId: "sess-1",
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gemini-3.8-flash-high",
      options: [
        { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
        { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
        { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
      ],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "yolo", name: "YOLO" }],
    },
  ],
};

test("antigravity projection lists the model option with no effort levels", () => {
  expect(projectAntigravityModels(newSessionResponse)).toEqual([
    { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-pro-agent", displayName: "Gemini 3.1 Pro (High)" },
  ]);
  expect(projectAntigravityModels({ configOptions: [] })).toBeUndefined();
  expect(projectAntigravityModels(null)).toBeUndefined();
});

test("antigravity lister initializes and opens a session, then kills the process without close", async () => {
  acp.request.mockImplementation(async (method) => {
    switch (method) {
      case "initialize":
        return { authMethods: [] };
      case "session/new":
        return newSessionResponse;
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  await expect(antigravityListModels(installation)).resolves.toMatchObject({ kind: "ok" });
  expect(acp.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "session/new"]);
  expect(acp.kill).toHaveBeenCalledOnce();
});

test("antigravity lister maps auth failures, a missing model option, and other failures", async () => {
  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return {};
    }
    throw new RequestError(-32_000, "Authentication required");
  });
  await expect(antigravityListModels(installation)).resolves.toEqual({
    kind: "unauthenticated",
    detail: "Authentication required",
  });

  acp.request.mockImplementation(async (method) => (method === "initialize" ? {} : { sessionId: "sess-2" }));
  await expect(antigravityListModels(installation)).resolves.toMatchObject({ kind: "unsupported" });
  await expect(antigravityListModels({ kind: "available", via: "bundled" })).resolves.toMatchObject({
    kind: "unsupported",
  });

  acp.request.mockImplementation(async () => {
    throw new Error("boom");
  });
  await expect(antigravityListModels(installation)).rejects.toThrow("Failed to list Antigravity models");
});
