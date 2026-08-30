import { afterEach, expect, test, vi } from "vitest";
import { grokAccountUsage } from "../packages/oar/src/runtimes/grok/account-usage.js";

const acp = vi.hoisted(() => ({
  kill: vi.fn<() => void>(),
  request: vi.fn<(
    method: string,
    params?: unknown,
    options?: unknown,
  ) => Promise<unknown>>(),
}));

vi.mock("../packages/oar/src/shared/acp/process.js", () => ({
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

const installation = {
  kind: "available",
  via: "executable",
  command: "grok",
  version: "1.0.5",
} as const;

function billing(): unknown {
  return {
    config: { creditUsagePercent: 25 },
    subscription_tier: "SuperGrok",
  };
}

afterEach(() => {
  acp.kill.mockReset();
  acp.request.mockReset();
});

test("grok reader merges email from the authenticated auth-info extension", async () => {
  acp.request.mockImplementation(async (method) => {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      case "_x.ai/billing":
        return billing();
      case "_x.ai/auth/info":
        return { methodId: "cached_token", email: "person@example.com" };
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });

  await expect(grokAccountUsage(installation)).resolves.toMatchObject({
    kind: "available",
    plan: "SuperGrok",
    email: "person@example.com",
    rateLimited: false,
  });
  expect(acp.request.mock.calls.map(([method]) => method)).toEqual([
    "initialize",
    "_x.ai/billing",
    "_x.ai/auth/info",
  ]);
  expect(acp.kill).toHaveBeenCalledOnce();
});

test("grok reader keeps billing when the optional auth-info extension fails", async () => {
  acp.request.mockImplementation(async (method) => {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      case "_x.ai/billing":
        return billing();
      case "_x.ai/auth/info":
        throw new Error("method unavailable");
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });

  await expect(grokAccountUsage(installation)).resolves.toEqual({
    kind: "available",
    plan: "SuperGrok",
    rateLimited: false,
    windows: [{ label: "Included usage", usedRatio: 0.25 }],
  });
});
