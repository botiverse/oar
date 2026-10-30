import { expect, it } from "vitest";
import { hookInputMatches, providerRequestsFor } from "../experiments/sharing/directory-hooks.js";

it.each([
  { tool_input: { text: "B_mcpafter" } },
  { toolInput: { tool_input: { text: "B_mcpafter" } } },
  { toolCall: { args: { Arguments: { text: "B_mcpafter" } } } },
  { input: { code: 'return await tools.scope.echo({"text":"B_mcpafter"});' } },
])("associates native tool input with its exact probe invocation", (event) => {
  expect(hookInputMatches(event, "B_mcpafter")).toBe(true);
  expect(hookInputMatches(event, "A_mcpafter")).toBe(false);
});

it("does not attribute a hook from incidental metadata or an unrecognized payload", () => {
  expect(hookInputMatches({ transcript: "B_mcpafter" }, "B_mcpafter")).toBe(false);
  expect(hookInputMatches({ input: { code: 'return "B_mcpafter";' } }, "B_mcpafter")).toBe(false);
});

it("captures only the current user turn, not a retained older marker", () => {
  const old = { body: { messages: [{ role: "user", content: "ACP_SHARE_A_mcpbefore" }] } };
  const current = { body: { contents: [
    { role: "user", parts: [{ text: "ACP_SHARE_A_mcpbefore" }] },
    { role: "user", parts: [{ text: "ACP_SHARE_B_mcpafter" }] },
    { role: "user", parts: [{ functionResponse: { result: "echo" } }] },
  ], systemInstruction: { parts: [{ text: "OAR_DIRECTORY_RULE_B" }] } } };
  expect(providerRequestsFor([old, current], "B_mcpafter")).toEqual([current]);
  expect(providerRequestsFor([old, current], "A_mcpbefore")).toEqual([old]);
});
