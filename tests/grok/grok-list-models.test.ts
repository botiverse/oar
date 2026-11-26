import { readerEnvironment, expectReaderEnvironment } from "../fixtures/reader-environment.js";
import { RequestError } from "../../packages/oar/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startAcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import { grokListModels, grokModelState, projectGrokModels } from "../../packages/oar/src/runtimes/grok/list-models.js";

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
    models: [{ id: "grok-4", displayName: "Grok 4", effortLevels: ["low", "high"], default: true }],
  });
  expect(acp.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "authenticate", "_x.ai/models/list"]);
  expect(acp.kill).toHaveBeenCalledOnce();
});

test("grok lister starts grok in the requested directory, as a session there would", async () => {
  acp.request.mockImplementation(async (method) => (method === "_x.ai/models/list" ? { result: { availableModels: [] } } : {}));
  await grokListModels(installation, { env: readerEnvironment(), cwd: "workspace" });
  expectReaderEnvironment(vi.mocked(startAcpProcess).mock.calls.at(-1)?.[3]?.env);
  expect(vi.mocked(startAcpProcess).mock.calls.at(-1)?.[3]).toMatchObject({ cwd: path.resolve("workspace") });
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

// grok 1.0.41 (live 2026-09-29) moved the effort menu under each entry's
// `_meta`, as `{id, value, label, description, default}` objects; before the
// lister read it there, every grok model listed without effort levels.
function grokEfforts(ids: readonly string[]): Record<string, unknown>[] {
  return ids.map((id) => ({ id, value: id, label: id, description: "", default: id === "high" }));
}

test("grok projection reads the effort menu grok 1.0.41 carries under _meta", () => {
  const frontier = grokEfforts(["xhigh", "high", "medium", "low"]);
  const older = grokEfforts(["high", "medium", "low"]);
  const state = grokModelState({
    currentModelId: "grok-4.7",
    availableModels: [
      { modelId: "grok-4.7", name: "Grok 4.7", _meta: { totalContextTokens: 500_000, supportsReasoningEffort: true, reasoningEffort: "high", reasoningEfforts: frontier } },
      { modelId: "grok-4.5", name: "Grok 4.5", _meta: { supportsReasoningEffort: true, reasoningEffort: "high", reasoningEfforts: older } },
      { modelId: "grok-plain", name: "Plain", _meta: { supportsReasoningEffort: false, reasoningEffort: "high", reasoningEfforts: older } },
    ],
  });
  expect(projectGrokModels(state)).toEqual([
    { id: "grok-4.7", displayName: "Grok 4.7", effortLevels: ["xhigh", "high", "medium", "low"], defaultEffort: "high", default: true },
    { id: "grok-4.5", displayName: "Grok 4.5", effortLevels: ["high", "medium", "low"], defaultEffort: "high" },
    { id: "grok-plain", displayName: "Plain" },
  ]);
});

// Real `_x.ai/models/list` from grok 1.0.77 (live 2026-11-26, no tokens): every
// entry carries `_meta.reasoningEfforts: [{id, value, label, description,
// default}]` with id === value, grok-4.6 offering xhigh/high/medium/low and
// grok-4.5 high/medium/low. `value` is the id `session/set_config_option`
// takes, so it is what a catalog must expose even when a build's `id` differs.
test("grok's real per-model effort menus are exposed as the values the session accepts", () => {
  const state = {
    currentModelId: "grok-4.6",
    availableModels: [
      { modelId: "grok-4.6", name: "Grok 4.6", _meta: { totalContextTokens: 500_000, supportsReasoningEffort: true, reasoningEffort: "high",
        reasoningEfforts: ["xhigh", "high", "medium", "low"].map((id) => ({ id, value: id, label: id, default: id === "high" })) } },
      { modelId: "grok-4.5", name: "Grok 4.5", _meta: { totalContextTokens: 500_000, supportsReasoningEffort: true, reasoningEffort: "high",
        reasoningEfforts: ["high", "medium", "low"].map((id) => ({ id, value: id, label: id, default: id === "high" })) } },
    ],
  };
  expect(projectGrokModels(state)).toEqual([
    { id: "grok-4.6", displayName: "Grok 4.6", effortLevels: ["xhigh", "high", "medium", "low"], defaultEffort: "high", default: true },
    { id: "grok-4.5", displayName: "Grok 4.5", effortLevels: ["high", "medium", "low"], defaultEffort: "high" },
  ]);
});

test("a menu whose catalog key differs from its wire value exposes the wire value only", () => {
  const state = {
    currentModelId: "relayed",
    availableModels: [{ modelId: "relayed", name: "Relayed", _meta: { supportsReasoningEffort: true, reasoningEffort: "low",
      reasoningEfforts: [{ id: "reasoning-low", value: "low", label: "Low" }, { id: "reasoning-high", value: "high", label: "High" }] } }],
  };
  expect(projectGrokModels(state)).toEqual([
    { id: "relayed", displayName: "Relayed", effortLevels: ["low", "high"], defaultEffort: "low", default: true },
  ]);
});

test("effort support without a readable menu names the gap instead of inventing levels", () => {
  const state = {
    currentModelId: "quiet",
    availableModels: [
      { modelId: "quiet", name: "Quiet", _meta: { supportsReasoningEffort: true } },
      { modelId: "empty", name: "Empty", _meta: { supportsReasoningEffort: true, reasoningEfforts: [] } },
      { modelId: "plain", name: "Plain", _meta: { supportsReasoningEffort: false, reasoningEfforts: ["low", "high"] } },
    ],
  };
  const entries = projectGrokModels(state);
  expect(entries.map((entry) => ({ id: entry.id, levels: entry.effortLevels, reason: entry.effortUnavailableReason }))).toEqual([
    { id: "quiet", levels: undefined, reason: "Grok reported reasoning support for this model without a readable effort menu." },
    { id: "empty", levels: undefined, reason: "Grok reported reasoning support for this model without a readable effort menu." },
    // A model grok says takes no effort lists none, and OAR claims no gap either.
    { id: "plain", levels: undefined, reason: undefined },
  ]);
});
