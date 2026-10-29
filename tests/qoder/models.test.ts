import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { qoderListModels, projectQoderModels } from "../../packages/oar/src/runtimes/qoder/list-models.js";
import { launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { qoderAuthStatus } from "../../packages/oar/src/runtimes/qoder/auth-status.js";

test("native catalog uses selector ids and preserves disabled entries without exposing private fields", () => {
  expect(projectQoderModels({ account: { email: "private@example.invalid" }, models: [
    { value: "qfmodel", displayName: "Qwen 3.8 Flash", serverModel: { display_name: "Qwen3.8-Flash", token: "private" }, isDefault: true, isEnabled: true, efforts: ["low", "high"], defaultEffort: "low", token: "private" },
    { value: "disabled-model", displayName: "Disabled", isEnabled: false },
    { displayName: "No native id" },
  ] })).toEqual([
    { id: "qfmodel", resolvedId: "Qwen3.8-Flash", displayName: "Qwen 3.8 Flash", default: true, effortLevels: ["low", "high"], defaultEffort: "low" },
    { id: "disabled-model", displayName: "Disabled", disabled: { reason: "Qoder reports this model disabled" } },
  ]);
});

test("model display labels do not substitute for an absent native resolved name", () => {
  expect(projectQoderModels({ models: [
    { value: "a", displayName: "A" },
    { value: "b", displayName: "B", serverModel: { display_name: "" } },
    { value: "c", serverModel: { display_name: null } },
    { value: "literal", serverModel: { display_name: "literal" } },
  ] })).toEqual([{ id: "a", displayName: "A" }, { id: "b", displayName: "B" }, { id: "c" }, { id: "literal" }]);
});

vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => ({
  launchQoder: vi.fn(async () => ({ onLine: vi.fn(), onExit: vi.fn() })),
  closeQoder: vi.fn(async () => {}),
}));
vi.mock("../../packages/oar/src/runtimes/qoder/auth-status.js", () => ({ qoderAuthStatus: vi.fn(async () => ({ kind: "logged_in" })) }));
vi.mock("../../packages/oar/src/runtimes/qoder/control.js", () => ({ qoderControl: () => ({
  request: async () => ({ response: { response: { models: [{ value: "model" }] } } }),
  consume: vi.fn(), end: vi.fn(),
}) }));

test("Qoder model listing uses the same environment for authentication and the native catalog", async () => {
  const env = { HOME: "scoped-home", REMOVED: null };
  const result = await qoderListModels({ kind: "available", via: "executable", command: "qodercli" }, { cwd: resolve("/project"), env });
  expect(result).toEqual({ kind: "ok", models: [{ id: "model" }] });
  expect(vi.mocked(qoderAuthStatus).mock.calls[0]?.[1]?.env).toEqual(env);
  expect(vi.mocked(launchQoder).mock.calls[0]?.[2]).toEqual({ cwd: resolve("/project"), env });
});
