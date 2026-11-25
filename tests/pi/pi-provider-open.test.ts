import { afterEach, expect, test, vi } from "vitest";
import { openPiAgentSession } from "../../packages/oar/src/runtimes/pi/open.js";

const sdk = vi.hoisted(() => ({
  getAgentDir: () => "/fake/agent",
  SettingsManager: { create: vi.fn() },
  SessionManager: { create: () => ({}) },
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => sdk);
vi.mock("../../packages/oar/src/runtimes/pi/static-modules.js", () => ({ preparePi: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

/** A settings manager the open path reaches, so its compaction overrides can be read back. */
function fakeSettings() {
  const applyOverrides = vi.fn();
  sdk.SettingsManager.create.mockReturnValue({ getProjectSettings: () => ({}), getGlobalSettings: () => ({}), applyOverrides });
  return { applyOverrides };
}

function fakeServices() {
  vi.stubEnv("PI_OFFLINE", "0");
  const selected = { provider: "gateway", id: "reasoner" };
  const getModel = vi.fn(() => selected);
  const registerProvider = vi.fn();
  sdk.createAgentSessionServices.mockResolvedValue({ modelRuntime: { getModel, registerProvider } });
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: { model: selected, dispose: vi.fn(), bindExtensions: vi.fn() } });
  return { selected, getModel, registerProvider };
}

test("a host-declared provider is registered in the session's model plane before the model resolves", async () => {
  const settings = fakeSettings();
  const { selected, getModel, registerProvider } = fakeServices();
  await openPiAgentSession({
    cwd: "/work",
    model: "reasoner",
    piProvider: {
      id: "gateway",
      api: "openai-completions",
      baseUrl: "https://gateway.example.test/v1/",
      apiKeyEnv: "GATEWAY_API_KEY",
      models: [{ id: "reasoner", contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" } }],
    },
    piCompaction: { reserveTokens: 16_384, keepRecentTokens: 8192 },
  });
  // Registered under the declared id, with the entry Pi's model plane takes.
  expect(registerProvider).toHaveBeenCalledWith("gateway", expect.objectContaining({
    name: "gateway",
    api: "openai-completions",
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "$GATEWAY_API_KEY",
    models: [expect.objectContaining({ id: "reasoner", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 })],
  }));
  // A bare id the provider serves is qualified with it, which is how Pi names a model.
  expect(getModel).toHaveBeenCalledWith("gateway", "reasoner");
  expect(sdk.createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ model: selected }));
  // The compaction budget lands on the session's settings manager, in memory.
  expect(settings.applyOverrides).toHaveBeenCalledWith({ compaction: { reserveTokens: 16_384, keepRecentTokens: 8192 } });
  // ...and AFTER the services built their resource loader: loading it reloads
  // Pi's settings from the user's files and would discard an earlier override.
  const overrideOrder = settings.applyOverrides.mock.invocationCallOrder[0] ?? -1;
  const servicesOrder = sdk.createAgentSessionServices.mock.invocationCallOrder[0] ?? -1;
  expect(overrideOrder).toBeGreaterThan(servicesOrder);
});

test("no declared provider leaves the model plane and the settings untouched", async () => {
  const settings = fakeSettings();
  const { getModel, registerProvider } = fakeServices();
  await openPiAgentSession({ cwd: "/work", model: "gateway/reasoner" });
  expect(registerProvider).not.toHaveBeenCalled();
  expect(settings.applyOverrides).not.toHaveBeenCalled();
  expect(getModel).toHaveBeenCalledWith("gateway", "reasoner");
});

test("a declaration Pi cannot honour is refused before any session is created", async () => {
  fakeSettings();
  fakeServices();
  await expect(openPiAgentSession({ cwd: "/work", piProvider: { id: "bad id", api: "openai-completions", baseUrl: "https://gateway.example.test/v1", models: [{ id: "m", contextWindow: 10, maxTokens: 1 }] } }))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "piProvider" });
  expect(sdk.createAgentSessionServices).not.toHaveBeenCalled();
});
