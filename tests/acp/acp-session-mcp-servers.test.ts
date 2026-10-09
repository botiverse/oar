import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RuntimeFailureError } from "../../packages/oar/src/contracts/runtime-failure-error.js";
import type { McpServer, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture, profile } from "../fixtures/acp-session-support.js";

/**
 * SessionOptions.mcpServers on the wire of an ACP open
 * (shared/acp/mcp-servers.ts), against the scripted agent
 * (fixtures/fake-acp-mcp.mjs logs each open's `mcpServers` param): ACP's
 * `McpServer` shape on `session/new` and again on `session/resume`, http
 * only where `initialize` declares it, and no credential in a record or an
 * error. The vendor tests (sea-trial/vendor/mcp-servers-acp.vendor.test.ts)
 * show each real agent calling the servers.
 */

const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const servers: readonly McpServer[] = [
  { name: "echo", command: "/bin/echo-server", env: { OAR_ECHO_TOKEN: "stdio-secret-value" } },
  { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer http-secret-value" } },
];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh log file for the agent's opens, and the opens it holds. */
function openLog(): { readonly file: string; read(): readonly unknown[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-acp-mcp-"));
  dirs.push(dir);
  const file = path.join(dir, "opens.jsonl");
  return {
    file,
    read: () => {
      try {
        return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).map((line): unknown => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

async function open(options: Partial<SessionOptions>, env: Readonly<Record<string, string>>): ReturnType<ReturnType<typeof acpSession>> {
  return acpSession(profile())(installation, { cwd: process.cwd(), ...options, env });
}

/** Open and dispose one session: its records. */
async function openAndClose(options: Partial<SessionOptions>, env: Readonly<Record<string, string>>): Promise<{ readonly id: string; readonly records: string }> {
  const session = await open(options, env);
  await session.dispose();
  return { id: session.id, records: JSON.stringify(session.records()) };
}

test("the entries go out in ACP's McpServer shape on session/new and again on session/resume", async () => {
  const log = openLog();
  const env = { FAKE_ACP_MCP_LOG: log.file, FAKE_ACP_MCP_HTTP: "1" };
  const session = await openAndClose({ mcpServers: servers }, env);
  const resumed = await openAndClose({ resume: session.id, mcpServers: [{ name: "bare", command: "/bin/bare" }] }, env);
  await openAndClose({}, env);
  expect(log.read()).toEqual([
    {
      method: "session/new",
      mcpServers: [
        { name: "echo", command: "/bin/echo-server", args: [], env: [{ name: "OAR_ECHO_TOKEN", value: "stdio-secret-value" }] },
        { type: "http", name: "remote", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer http-secret-value" }] },
      ],
    },
    { method: "session/resume", mcpServers: [{ name: "bare", command: "/bin/bare", args: [], env: [] }] },
    { method: "session/new", mcpServers: [] },
  ]);
  const records = session.records + resumed.records;
  expect(["stdio-secret-value", "http-secret-value"].filter((secret) => records.includes(secret))).toEqual([]);
});

test("an http entry is refused when initialize declares no mcpCapabilities.http, before any session opens", async () => {
  const log = openLog();
  const refused = open({ mcpServers: servers }, { FAKE_ACP_MCP_LOG: log.file });
  await expect(refused).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
  await expect(refused).rejects.toThrow('declares no mcpCapabilities.http, so it attaches no http MCP server ("remote")');
  expect(log.read()).toEqual([]);
  const stdioOnly = await open({ mcpServers: servers.slice(0, 1) }, { FAKE_ACP_MCP_LOG: log.file });
  await stdioOnly.dispose();
  expect(log.read()).toHaveLength(1);
});

test("a list with an empty or repeated name fails before the agent starts", async () => {
  const log = openLog();
  await expect(open({ mcpServers: [servers[0] ?? { name: "", command: "" }, { name: "echo", command: "/bin/other" }] }, { FAKE_ACP_MCP_LOG: log.file })).rejects.toThrow('mcpServers names "echo" twice');
  await expect(open({ mcpServers: [{ name: "", command: "/bin/x" }] }, { FAKE_ACP_MCP_LOG: log.file })).rejects.toThrow("mcpServers has an entry with an empty name");
  expect(log.read()).toEqual([]);
});

test("an open that fails reports no credential its servers carry", async () => {
  const opening = open({ mcpServers: servers }, { FAKE_ACP_MCP_HTTP: "1", FAKE_ACP_MCP_FAIL: "1" });
  await expect(opening).rejects.toThrow(/cannot start .*"value":"\[redacted\]"/u);
  const failure: unknown = await opening.catch((error: unknown) => error);
  expect(String(failure instanceof Error ? failure.stack : failure)).not.toMatch(/stdio-secret-value|http-secret-value/u);
});

// An open refused as a RuntimeFailureError keeps the agent's words in `reason` and its `cause`: neither may hold a credential.
test("an open refused for auth reports no credential its servers carry, in its reason or its cause", async () => {
  const failure: unknown = await open({ mcpServers: servers }, { FAKE_ACP_MCP_HTTP: "1", FAKE_ACP_MCP_FAIL: "1", FAKE_ACP_MCP_FAIL_CODE: "-32000" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RuntimeFailureError);
  expect(failure).toMatchObject({ failure: "auth" });
  const refused = failure instanceof RuntimeFailureError ? failure : null;
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest's asymmetric matcher is intentionally untyped.
  expect(refused?.cause).toMatchObject({ method: "session/new", native: { message: expect.stringMatching(/cannot start .*"value":"\[redacted\]"/u) } });
  for (const text of [refused?.message, refused?.reason, refused?.stack, JSON.stringify(refused?.cause)]) {
    expect(String(text)).not.toMatch(/stdio-secret-value|http-secret-value/u);
  }
});

const antigravity = acpSession({ ...antigravityAcpProfile, args: [fixture, "antigravity"] });

test.each(servers)("antigravity refuses an entry carrying a credential before it starts: $name", async (server) => {
  const log = openLog();
  const opening = antigravity(installation, { cwd: process.cwd(), mcpServers: [server], env: { FAKE_ACP_MCP_LOG: log.file, FAKE_ACP_MCP_HTTP: "1" } });
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
  await expect(opening).rejects.toThrow(`stores a session's MCP servers, env and header values included, in plain text in its conversation database, where they outlive the session; it attaches no entry with env or headers (${JSON.stringify(server.name)})`);
  expect(log.read()).toEqual([]);
});

test("antigravity attaches entries without credentials", async () => {
  const log = openLog();
  const env = { FAKE_ACP_MCP_LOG: log.file, FAKE_ACP_MCP_HTTP: "1" };
  const bare: readonly McpServer[] = [{ name: "echo", command: "/bin/echo-server", env: {} }, { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp" }];
  const session = await antigravity(installation, { cwd: process.cwd(), mcpServers: bare, env });
  await session.dispose();
  expect(log.read()).toEqual([{
    method: "session/new",
    mcpServers: [
      { name: "echo", command: "/bin/echo-server", args: [], env: [] },
      { type: "http", name: "remote", url: "http://127.0.0.1:9/mcp", headers: [] },
    ],
  }]);
});
