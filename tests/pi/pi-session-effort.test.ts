import { expect, test } from "vitest";
import { piEffortRefusal, piThinkingLevel } from "../../packages/oar/src/runtimes/pi/open.js";
import { foldPiEvent, initialPiProjection } from "../../packages/oar/src/runtimes/pi/projection.js";

// SessionOptions.effort on pi is the creation-time `thinkingLevel` (SDK
// 0.84.2): spelled in pi's own levels, checked before pi sees it (pi would
// clamp an unknown word to the model's lowest level without a word), and read
// back from AgentSession.thinkingLevel after pi clamped it to the model.

test("piThinkingLevel takes pi's own level names and refuses anything else, naming pi's levels", () => {
  expect(piThinkingLevel("xhigh")).toBe("xhigh");
  expect(piThinkingLevel("off")).toBe("off");
  expect(() => piThinkingLevel("ultra")).toThrow("pi has no thinking level ultra (pi's levels: off, minimal, low, medium, high, xhigh, max)");
});

function session(thinkingLevel: string, levels: readonly string[]): Parameters<typeof piEffortRefusal>[1] {
  return { model: { provider: "openai-codex", id: "gpt-5.5" }, thinkingLevel, getAvailableThinkingLevels: () => levels };
}

test("piEffortRefusal is null when pi runs the requested level and names what it clamped to otherwise", () => {
  expect(piEffortRefusal("high", session("high", ["off", "low", "high"]))).toBeNull();
  expect(piEffortRefusal("max", session("xhigh", ["off", "minimal", "low", "medium", "high", "xhigh"]))).toBe(
    "pi runs thinking level xhigh for openai-codex/gpt-5.5 although max was requested (the model offers off, minimal, low, medium, high, xhigh)",
  );
  expect(piEffortRefusal("low", { ...session("off", ["off"]), model: undefined })).toBe(
    "pi runs thinking level off for no model although low was requested (the model offers off)",
  );
});

test("pi's thinking_level_changed is its own report of the level the next request runs", () => {
  const { commands } = foldPiEvent(initialPiProjection, { type: "thinking_level_changed", level: "high" });
  expect(commands).toEqual([{
    kind: "frame",
    body: { type: "thinking_level_changed", native: { type: "thinking_level_changed", level: "high" }, events: [{ kind: "effort", effort: "high" }] },
  }]);
});
