import assert from "node:assert/strict";
import test from "node:test";
import { parseKimiCodeConfigToml } from "./kimiCatalog.js";

const SAMPLE = `
default_model = "kimi-code/k3"

[models."kimi-k2.5"]
provider = "ark-openai"
model = "kimi-k2.5"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`;

test("parseKimiCodeConfigToml extracts models + display_name + efforts", () => {
  const { models, defaultModel } = parseKimiCodeConfigToml(SAMPLE);
  assert.equal(defaultModel, "kimi-code/k3");
  assert.equal(models.length, 2);
  assert.equal(models[0]!.id, "kimi-k2.5");
  assert.equal(models[1]!.id, "kimi-code/k3");
  assert.equal(models[1]!.label, "K3");
  assert.deepEqual(models[1]!.supportedReasoningEfforts, ["low", "high", "max"]);
});

test("empty toml yields zero models", () => {
  const { models } = parseKimiCodeConfigToml("default_plan_mode = false\n");
  assert.equal(models.length, 0);
});
