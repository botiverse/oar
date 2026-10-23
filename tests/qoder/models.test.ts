import { expect, test } from "vitest";
import { projectQoderModels } from "../../packages/oar/src/runtimes/qoder/list-models.js";

test("native catalog uses selector ids and preserves disabled entries without exposing private fields", () => {
  expect(projectQoderModels({ account: { email: "private@example.invalid" }, models: [
    { value: "qfmodel", displayName: "Qwen 3.8 Flash", isDefault: true, isEnabled: true, efforts: ["low", "high"], defaultEffort: "low", token: "private" },
    { value: "disabled-model", displayName: "Disabled", isEnabled: false },
    { displayName: "No native id" },
  ] })).toEqual([
    { id: "qfmodel", displayName: "Qwen 3.8 Flash", default: true, effortLevels: ["low", "high"], defaultEffort: "low" },
    { id: "disabled-model", displayName: "Disabled", disabled: { reason: "Qoder reports this model disabled" } },
  ]);
});
