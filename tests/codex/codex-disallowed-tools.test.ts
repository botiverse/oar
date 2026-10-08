import { expect, test } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { codexToolDenialsConfig, withCodexToolDenials } from "../../packages/oar/src/runtimes/codex/tool-denials.js";

const cwd = "/tmp";
test("MCP denials union with native filters and do not copy credentials or other server settings", () => {
  const effective = { mcp_servers: { echo: { command: "private-command", env: { KEY: "secret" }, disabled_tools: ["prior"] } } };
  const options = { cwd, disallowedTools: ["mcp__echo__echo", "mcp__echo__prior"] };
  const filters = codexToolDenialsConfig(options, effective);
  expect(filters).toEqual({ echo: { disabled_tools: ["prior", "echo"] } });
  expect(effective.mcp_servers.echo.disabled_tools).toEqual(["prior"]);
  expect(withCodexToolDenials({ model: "m", config: { model_reasoning_effort: "high", mcp_servers: { echo: { command: "session-command", args: ["arg"] }, other: { url: "https://example.invalid" } } } }, filters)).toEqual({
    model: "m", config: { model_reasoning_effort: "high", mcp_servers: { echo: { command: "session-command", args: ["arg"], disabled_tools: ["prior", "echo"] }, other: { url: "https://example.invalid" } } },
  });
});

test("session-only servers resolve; unknown or ambiguous namespaces are explicitly refused", () => {
  expect(codexToolDenialsConfig({ cwd, mcpServers: [{ name: "echo", command: "node" }], disallowedTools: ["mcp__echo__a"] }, {})).toEqual({ echo: { disabled_tools: ["a"] } });
  expect(() => codexToolDenialsConfig({ cwd, disallowedTools: ["mcp__absent__a"] }, {})).toThrow('mcp__absent__a');
  expect(() => codexToolDenialsConfig({ cwd, disallowedTools: ["mcp__a__b__tool"] }, { mcp_servers: { a: {}, a__b: {} } })).toThrow("cannot identify one");
});

test("builtins and unqualified tool names reject before starting app-server, including mixed lists", async () => {
  const opening = codexSession({ kind: "available", via: "executable", command: "/nonexistent" }, { cwd, resume: "old", disallowedTools: ["mcp__echo__echo", "exec_command", "echo"] });
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "disallowedTools" });
  await expect(opening).rejects.toThrow('["exec_command","echo"]');
});
