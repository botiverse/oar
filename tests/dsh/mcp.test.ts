import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeAgentBinary } from "../fixtures/process-tree.js";
import { expect, test } from "vitest";
import { dshRuntime, UnsupportedOptionError, type McpServer } from "../../packages/oar/src/index.js";

test.each([
  ["HTTP", { name: "remote", type: "http", url: "http://localhost:1" }],
  ["environment", { name: "echo", command: "node", env: { PRIVATE_TOKEN: "synthetic-secret" } }],
  ["headers", { name: "remote", type: "http", url: "http://localhost:1", headers: { Authorization: "synthetic-secret" } }],
  ["native name format", { name: "two words", command: "node" }],
  ["native name length", { name: "a".repeat(33), command: "node" }],
  ["reserved name", { name: "__proto__", command: "node" }],
] satisfies readonly (readonly [string, McpServer])[])("DSH refuses %s before any executable starts", async (_label, server) => {
  const refused = await dshRuntime.session({ kind: "available", via: "executable", command: "must-not-be-spawned" }, { cwd: process.cwd(), mcpServers: [server] }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(UnsupportedOptionError);
  expect(refused).toMatchObject({ option: "mcpServers" });
  expect(String(refused)).not.toContain("synthetic-secret");
});

test("duplicate names cannot replace each other", async () => {
  await expect(dshRuntime.session({ kind: "available", via: "executable", command: "must-not-be-spawned" }, {
    cwd: process.cwd(), mcpServers: [{ name: "same", command: "node" }, { name: "same", command: "node" }],
  })).rejects.toThrow('names "same" twice');
});


test.each(["no-mcp-method", "mcp-inactive"])("a native loader that cannot confirm the requested MCP refuses startup: %s", async (mode) => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-dsh-mcp-fault-"));
  try {
    const command = fakeAgentBinary(directory, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
    const refused = await dshRuntime.session({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, {
      cwd: directory, env: { FAKE_DSH_MODE: mode }, mcpServers: [{ name: "echo", command: process.execPath }],
    }).catch((error: unknown) => error);
    if (mode === "no-mcp-method") {
      expect(refused).toBeInstanceOf(UnsupportedOptionError);
      expect(refused).toMatchObject({ option: "mcpServers" });
    } else { expect(String(refused)).toContain("not active (native state 0)"); }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}, 30_000);
