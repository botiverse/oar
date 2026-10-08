import { expect, test } from "vitest";
import type { McpServer } from "../packages/oar/src/contracts/session.js";
import { piSession } from "../packages/oar/src/runtimes/pi/session.js";
import { piMcpServerConfig, validatePiMcpEnvironment } from "../packages/oar/src/runtimes/pi/mcp.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

test.each(allRuntimes.list())("$id: null in an MCP entry is refused before opening", async (runtime) => {
  // JavaScript callers can supply an invalid map even though the MCP type rejects it.
  const server: McpServer = { name: "probe", command: "/nonexistent/oar-env-probe", env: {
    // @ts-expect-error Only SessionOptions.env accepts null, not an MCP server's native env.
    KEY: null,
  } };
  const installation = runtime.id === "pi" || runtime.id === "cursor"
    ? { kind: "available", via: "bundled" } as const
    : { kind: "available", via: "executable", command: "/nonexistent/oar-env-probe" } as const;
  await expect(runtime.session(installation, { cwd: "/nonexistent/oar-env-probe", mcpServers: [server] })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
});

test("pi refuses an env removal with stdio MCP before opening or naming the removed variable", async () => {
  const options = { cwd: "/nonexistent/oar-env-probe", env: { PRIVATE_REMOVED_KEY: null }, mcpServers: [{ name: "probe", command: "node" }] };
  const opening = piSession({ kind: "available", via: "bundled" }, options);
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "env" });
  await expect(opening).rejects.toThrow("re-inherit the host environment");
  const failure: unknown = await opening.catch((error: unknown) => error);
  expect(String(failure)).not.toContain("PRIVATE_REMOVED_KEY");
  expect(() => piMcpServerConfig({ name: "probe", command: "node" }, { PRIVATE_REMOVED_KEY: null })).toThrow("cannot remove variables");
});

test("pi permits env removal without stdio MCP, including HTTP and empty lists", () => {
  const base = { cwd: "/tmp", env: { REMOVE: null } };
  expect(() => { validatePiMcpEnvironment(base); }).not.toThrow();
  expect(() => { validatePiMcpEnvironment({ ...base, mcpServers: [] }); }).not.toThrow();
  const remote = { name: "remote", type: "http", url: "https://example.com/mcp" } as const;
  expect(() => { validatePiMcpEnvironment({ ...base, mcpServers: [remote] }); }).not.toThrow();
  expect(piMcpServerConfig(remote, base.env)).toEqual({ type: "http", url: remote.url, exposure: "direct" });
});

test("cursor still refuses env containing only removal entries", async () => {
  await expect(allRuntimes.require("cursor").session({ kind: "available", via: "bundled" }, { cwd: "/tmp", env: { REMOVE: null } })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "env" });
});
