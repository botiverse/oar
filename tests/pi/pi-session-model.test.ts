import { expect, test } from "vitest";
import { piEffectiveModel } from "../../packages/oar/src/runtimes/pi/session.js";

// pi's AgentSession.model is the runtime-owned current model (SDK 0.84.2);
// the adapter spells it provider/id and reports null while pi has none.
test("piEffectiveModel spells the session's current model as provider/id", () => {
  expect(piEffectiveModel({ model: { provider: "xai", id: "grok-4" } })).toBe("xai/grok-4");
});

test("piEffectiveModel is null when pi has not selected a model", () => {
  expect(piEffectiveModel({ model: undefined })).toBeNull();
});
