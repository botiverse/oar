import { expect, test } from "vitest";
import { piLiteralConfigValue, piMcpExtensions, piMcpServerConfig } from "../../packages/oar/src/runtimes/pi/mcp.js";

/**
 * SessionOptions.mcpServers as pi's MCP server configs (runtimes/pi/mcp.ts),
 * checked without a model; the vendor test (sea-trial/vendor/
 * mcp-servers-pi.vendor.test.ts) shows the agent calling them.
 */

/** pi's own resolver for `env` and `headers` values (not exported from the package root). */
async function piResolve(value: string): Promise<string | undefined> {
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- pi's untyped dist module.
  const resolver = await import(new URL("core/resolve-config-value.js", root).href) as { resolveConfigValue(config: string, env?: Record<string, string>): string | undefined };
  return resolver.resolveConfigValue(value, { HOME: "/home/someone" });
}

test("every env and header value reaches pi literally: no shell command, no variable", async () => {
  // oxlint-disable-next-line no-template-curly-in-string -- pi's own `${NAME}` reference, written literally.
  for (const value of ["!echo pwned", "$HOME", "${HOME}/x", "a$$b", "$!", "plain-token", "Bearer abc!def$"]) {
    // oxlint-disable-next-line no-await-in-loop -- one value at a time keeps the failure attributable.
    expect(await piResolve(piLiteralConfigValue(value)), value).toBe(value);
  }
});

test("a stdio entry gets SessionOptions.env under its own env, an http one its headers, each declared to the model directly", () => {
  expect(piMcpServerConfig({ name: "echo", command: "node", args: ["server.mjs"], env: { TOKEN: "!secret", SHARED: "entry" } }, { SHARED: "session", DEPTH: "1" })).toEqual({
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: { SHARED: "entry", DEPTH: "1", TOKEN: "$!secret" },
    exposure: "direct",
  });
  expect(piMcpServerConfig({ name: "echo", command: "node" })).toEqual({ type: "stdio", command: "node", args: [], exposure: "direct" });
  expect(piMcpServerConfig({ name: "remote", type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer $x" } })).toEqual({
    type: "http",
    url: "http://127.0.0.1:1/mcp",
    headers: { Authorization: "Bearer $$x" },
    exposure: "direct",
  });
});

async function open(names: readonly string[]): Promise<unknown> {
  return piMcpExtensions({ cwd: "/tmp", mcpServers: names.map((name) => ({ name, command: "node" })) }, "/tmp");
}

test("a list pi cannot register as given fails before anything opens", async () => {
  await expect(open(["my server"])).rejects.toThrow('pi registers no MCP server named "my server"');
  await expect(open(["a-b", "a_b"])).rejects.toThrow('pi would give the MCP servers "a-b" and "a_b" one tool namespace (mcp__a_b)');
  await expect(open(["echo", "echo"])).rejects.toThrow('mcpServers names "echo" twice');
  await expect(open([])).resolves.toBeNull();
});
