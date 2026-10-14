import selection from "../fixtures/antigravity-1.4.0-config.json" with { type: "json" };
import { RequestError } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startAcpProcess } from "../../packages/oar/src/shared/acp/process.js";
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

const installation = { kind: "available", via: "executable", command: "agy_acp_server", version: "1.4.0" } as const;

// Native 1.4.0 API-key session: grouped model ids, with a menu only for the current model.
const newSessionResponse = { sessionId: "sess-1", ...selection };

test("antigravity lists native model families and the current model's effort menu", () => {
  expect(projectAntigravityModels(newSessionResponse)).toEqual([
    { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", default: true, effortLevels: ["low", "medium", "high"], defaultEffort: "high" },
    { id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
    { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash" },
    { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro" },
  ]);
  expect(projectAntigravityModels({ configOptions: [] })).toBeUndefined();
  expect(projectAntigravityModels(null)).toBeUndefined();
});

test("a catalog without a thought_level selector does not invent effort levels", () => {
  const response = { configOptions: selection.configOptions.filter((option) => option.category !== "thought_level") };
  expect(projectAntigravityModels(response)?.every((entry) => entry.effortLevels === undefined && entry.defaultEffort === undefined)).toBe(true);
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
  expect(acp.request.mock.calls[1]?.[1]).toEqual({ cwd: process.cwd(), mcpServers: [] });
});

test("antigravity lister opens its throwaway session in the requested directory", async () => {
  acp.request.mockImplementation(async (method) => (method === "session/new" ? newSessionResponse : {}));
  await antigravityListModels(installation, { cwd: "workspace" });
  const cwd = path.resolve("workspace");
  expect(vi.mocked(startAcpProcess).mock.calls.at(-1)?.[3]).toMatchObject({ cwd });
  expect(acp.request.mock.calls[1]?.[1]).toEqual({ cwd, mcpServers: [] });
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
