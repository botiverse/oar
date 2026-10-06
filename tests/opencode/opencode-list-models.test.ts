import { expect, test } from "vitest";
import { projectOpencodeModels } from "../../packages/oar/src/runtimes/opencode/list-models.js";

// The shape of `opencode models --verbose` (1.18.30, cli/cmd/models.ts): a
// `provider/model` line, then `JSON.stringify(model, null, 2)`. Fields
// trimmed to the ones the projection reads, plus one nested object so a
// closing brace inside the body is not taken for the model's end.
function block(id: string, model: object): string {
  return `${id}\n${JSON.stringify(model, null, 2)}\n`;
}

test("each model keeps its provider/model id, its name, and its variants as effort levels", () => {
  const stdout = [
    block("opencode/big-pickle", { id: "big-pickle", providerID: "opencode", name: "Big Pickle", limit: { context: 200_000 }, variants: {} }),
    block("anthropic/claude-haiku-4-5", {
      id: "claude-haiku-4-5",
      providerID: "anthropic",
      name: "Claude Haiku 4.5 (latest)",
      variants: { high: { thinking: { type: "enabled", budgetTokens: 16_000 } }, max: { thinking: { type: "enabled", budgetTokens: 31_999 } } },
    }),
  ].join("");
  expect(projectOpencodeModels(stdout)).toEqual([
    { id: "opencode/big-pickle", displayName: "Big Pickle" },
    { id: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5 (latest)", effortLevels: ["high", "max"] },
  ]);
});

test("the plain listing and stray output yield no entry without a model body", () => {
  expect(projectOpencodeModels("opencode/big-pickle\nopencode/fledge-alpha-free\n")).toEqual([]);
  expect(projectOpencodeModels("Models cache refreshed\n")).toEqual([]);
  expect(projectOpencodeModels("")).toEqual([]);
});
