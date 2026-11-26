import { expect, test } from "vitest";
import type { PiSessionProvider } from "../../packages/oar/src/contracts/pi-provider.js";
import { piRpcBootstrap, piRpcRefusedSessionOptions, piRpcRequestedModel } from "../../packages/oar/src/runtimes/pi/rpc/open.js";
import { refuseSessionOptions } from "../../packages/oar/src/shared/session-options.js";

/*
 * SessionOptions.piProvider in Pi's RPC execution mode: the declaration
 * travels in the private bootstrap document the session's own extension reads
 * over fd 3, never in models.json, a command line, or a file the user can see.
 * SessionOptions.piCompaction stays refused there: that child compacts from the
 * settings files it loads, and its extension API reads settings back only
 * (pi.getSettings() returns a copy and has no setter), so no supported channel
 * reaches its settings manager. The real child is pinned in
 * sea-trial/vendor/pi-rpc-compaction-channel.vendor.test.ts.
 */

const provider: PiSessionProvider = {
  id: "gateway",
  api: "openai-completions",
  baseUrl: "https://gateway.example.test/v1/",
  apiKeyEnv: "GATEWAY_API_KEY",
  models: [
    { id: "reasoner", contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" } },
    { id: "writer", contextWindow: 200_000, maxTokens: 16_384 },
  ],
};

test("a declared provider travels in the child's bootstrap document in Pi's registration shape", () => {
  const bootstrap = piRpcBootstrap({ cwd: "/work", piProvider: provider, model: "reasoner", mcpServers: [{ name: "probe", command: "/nonexistent/oar-probe", env: { PROBE: "1" } }] },
    { agentDir: "/agent", projectTrusted: true });
  expect(bootstrap.provider).toEqual({
    id: "gateway",
    entry: {
      name: "gateway",
      api: "openai-completions",
      baseUrl: "https://gateway.example.test/v1",
      // The NAME of the variable, never the key: Pi resolves it at request time.
      apiKey: "$GATEWAY_API_KEY",
      models: [
        expect.objectContaining({ id: "reasoner", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 }),
        expect.objectContaining({ id: "writer", reasoning: false, contextWindow: 200_000, maxTokens: 16_384 }),
      ],
    },
  });
  // The session's own MCP servers keep the same bootstrap field they always had.
  expect(bootstrap.servers.map((server) => server.name)).toEqual(["probe"]);
  expect(bootstrap).toMatchObject({ agentDir: "/agent", resume: false, hasHostAppend: false, projectTrusted: true });
});

test("no declaration leaves the bootstrap without a provider registration", () => {
  const bootstrap = piRpcBootstrap({ cwd: "/work", model: "gateway/reasoner" }, { agentDir: "/agent", projectTrusted: false });
  expect("provider" in bootstrap).toBe(false);
  expect(bootstrap).toMatchObject({ agentDir: "/agent", projectTrusted: false });
});

test.each([
  { label: "a bare id the provider serves", model: "reasoner", resume: false, expected: "gateway/reasoner" },
  { label: "an already qualified id", model: "gateway/writer", resume: false, expected: "gateway/writer" },
  { label: "an id no declared provider serves", model: "other/model", resume: false, expected: "other/model" },
  { label: "no model on a new session: the provider's first", model: undefined, resume: false, expected: "gateway/reasoner" },
  { label: "no model on a resumed session: keep what it recorded", model: undefined, resume: true, expected: undefined },
])("$label", ({ model, resume, expected }) => {
  expect(piRpcRequestedModel({ cwd: "/work", piProvider: provider, ...(model === undefined ? {} : { model }), ...(resume ? { resume: "old" } : {}) })).toBe(expected);
});

test("without a declared provider the requested model is Pi's own spelling, unchanged", () => {
  expect(piRpcRequestedModel({ cwd: "/work", model: "gateway/reasoner" })).toBe("gateway/reasoner");
  expect(piRpcRequestedModel({ cwd: "/work" })).toBeUndefined();
});

test("a declaration Pi cannot honour is refused before the child starts", () => {
  expect(() => { piRpcRequestedModel({ cwd: "/work", model: "reasoner", piProvider: { ...provider, baseUrl: "ftp://gateway.example.test/v1" } }); })
    .toThrow(/piProvider\.baseUrl must be HTTP\(S\)/u);
});

test("RPC takes the provider and still refuses the compaction budget", () => {
  expect(() => { refuseSessionOptions(piRpcRefusedSessionOptions, { cwd: "/work", piProvider: provider }); }).not.toThrow();
  expect(piRpcRefusedSessionOptions.piProvider).toBeUndefined();
  expect(piRpcRefusedSessionOptions.fork).toBeUndefined();
  expect(() => { refuseSessionOptions(piRpcRefusedSessionOptions, { cwd: "/work", piCompaction: { reserveTokens: 100_000 } }); })
    .toThrow(expect.objectContaining({ name: "UnsupportedOptionError", option: "piCompaction" }));
  // The reason names the verified cause and the mode that does honor a budget.
  expect(piRpcRefusedSessionOptions.piCompaction).toMatch(/settings files its child loads/u);
  expect(piRpcRefusedSessionOptions.piCompaction).toMatch(/getSettings\(\) returns a copy and exposes no setter/u);
  expect(piRpcRefusedSessionOptions.piCompaction).toMatch(/in-process execution mode/u);
});
