import { afterEach, expect, test, vi } from "vitest";
import { ModelConfirmationError, RuntimeFailureError } from "../../packages/oar/src/index.js";
import { createPiSession } from "../../packages/oar/src/runtimes/pi/session.js";
import { openPiAgentSession } from "../../packages/oar/src/runtimes/pi/open.js";

const sdk = vi.hoisted(() => ({
  getAgentDir: () => "/fake/agent",
  SettingsManager: { create: () => ({ getProjectSettings: () => ({}), getGlobalSettings: () => ({}) }) },
  SessionManager: { create: () => ({}) },
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => sdk);
vi.mock("../../packages/oar/src/runtimes/pi/static-modules.js", () => ({ preparePi: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

function fakeServices(model: { provider: string; id: string } | undefined) {
  vi.stubEnv("PI_OFFLINE", "0");
  const selected = { provider: "fixture", id: "requested" };
  const lookup = vi.fn(() => selected);
  sdk.createAgentSessionServices.mockResolvedValue({ modelRuntime: { getModel: lookup } });
  const session = { model, dispose: vi.fn(), bindExtensions: vi.fn() };
  sdk.createAgentSessionFromServices.mockResolvedValue({ session });
  return { selected, lookup, session };
}

test.each([undefined, { provider: "fixture", id: "other" }])("Pi disposes a session whose model readback did not confirm its selection: %j", async (model) => {
  const { selected, lookup, session } = fakeServices(model);
  const opening = createPiSession()({ kind: "available", via: "bundled" }, { cwd: "/work", model: "fixture/requested" });
  await expect(opening).rejects.toBeInstanceOf(ModelConfirmationError);
  await expect(opening).rejects.toMatchObject({ requested: "fixture/requested", reported: model === undefined ? null : "fixture/other",
    message: `pi did not apply model fixture/requested: the session reports ${model === undefined ? "no model" : "fixture/other"}` });
  await expect(opening).rejects.not.toHaveProperty("catalogSelectorIds");
  expect(lookup).toHaveBeenCalledWith("fixture", "requested");
  expect(sdk.createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ model: selected }));
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(session.bindExtensions).not.toHaveBeenCalled();
});

test("an unregistered Pi model keeps model_unavailable rather than becoming a confirmation mismatch", async () => {
  vi.stubEnv("PI_OFFLINE", "0");
  sdk.createAgentSessionServices.mockResolvedValue({ modelRuntime: { getModel: () => undefined } });
  const opening = openPiAgentSession({ cwd: "/work", model: "fixture/missing" });
  await expect(opening).rejects.toBeInstanceOf(RuntimeFailureError);
  await expect(opening).rejects.toMatchObject({ failure: "model_unavailable" });
  expect(sdk.createAgentSessionFromServices).not.toHaveBeenCalled();
});
