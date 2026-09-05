import { RequestError } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { afterEach, expect, test, vi } from "vitest";
import { grokListModels } from "../../packages/oar/src/runtimes/grok/list-models.js";

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

const installation = { kind: "available", via: "executable", command: "grok", version: "1.0.12" } as const;

afterEach(() => {
  acp.kill.mockReset();
  acp.request.mockReset();
});

test("grok lister initializes, authenticates with the cached token, then lists", async () => {
  acp.request.mockImplementation(async (method) => {
    switch (method) {
      case "initialize":
        return { authMethods: [{ id: "cached_token" }] };
      case "authenticate":
        return {};
      case "_x.ai/models/list":
        return {
          result: {
            currentModelId: "grok-4",
            availableModels: [{ modelId: "grok-4", name: "Grok 4", reasoning_efforts: ["low", "high"] }],
          },
        };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  await expect(grokListModels(installation)).resolves.toEqual({
    kind: "ok",
    models: [{ id: "grok-4", displayName: "Grok 4", effortLevels: ["low", "high"] }],
  });
  expect(acp.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "authenticate", "_x.ai/models/list"]);
  expect(acp.kill).toHaveBeenCalledOnce();
});

test("grok lister maps method-not-found to unsupported", async () => {
  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return { authMethods: [] };
    }
    throw new RequestError(-32_601, "Method not found");
  });
  await expect(grokListModels(installation)).resolves.toMatchObject({ kind: "unsupported" });
});

test("grok lister maps an auth failure to unauthenticated", async () => {
  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return { authMethods: [] };
    }
    throw new RequestError(-32_000, "Authentication required");
  });
  await expect(grokListModels(installation)).resolves.toEqual({
    kind: "unauthenticated",
    detail: "Authentication required",
  });
});

test("grok lister surfaces a handler-level error as a failure", async () => {
  acp.request.mockImplementation(async (method) => {
    if (method === "initialize") {
      return { authMethods: [] };
    }
    return { error: { message: "catalog fetch failed" } };
  });
  await expect(grokListModels(installation)).rejects.toThrow(/Failed to list Grok models/u);
  expect(acp.kill).toHaveBeenCalledOnce();
});
