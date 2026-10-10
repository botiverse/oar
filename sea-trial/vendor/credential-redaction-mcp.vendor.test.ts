import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { piSession } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { ECHO_SERVER, startHttpEcho } from "./support/echo-mcp.js";
import { runTurn } from "./support/asserts.js";

const firstKey = "oar-provider-echo-secret-one";

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi MCP metadata stays readable while Authorization and its bare token are redacted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-mcp-credential-test-"));
  const http = await startHttpEcho();
  const password = "oar-database:password/sentinel";
  const encodedPassword = encodeURIComponent(password);
  const databaseUrl = `postgres://user:${encodedPassword}@localhost/db`;
  const mongoUrl = `mongodb+srv://user:${encodedPassword}@localhost/db`;
  const reply = `debug is true in production; application/json; Bearer ${firstKey}; ${firstKey}; ${databaseUrl}; ${mongoUrl}; ${password}; ${encodedPassword}; http://localhost:3000`;
  const provider = await startPiAimock((mock) => {
    mock.on({ hasToolResult: false }, { toolCalls: [{ name: "mcp__local__echo", arguments: JSON.stringify({ text: reply }), id: "call_echo" }] });
    mock.on({ hasToolResult: true }, { content: "done" });
  });
  try {
    const session = await piSession({ kind: "available", via: "bundled" }, {
      cwd: directory, model: "aimock/aimock-model", env: { DATABASE_URL: databaseUrl },
      mcpServers: [
        { name: "local", command: process.execPath, args: [ECHO_SERVER], env: { DEBUG: "true", LOG_LEVEL: "debug", NODE_ENV: "production", MONGODB_URI: mongoUrl } },
        { name: "remote", type: "http", url: http.url, headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstKey}` } },
      ],
    });
    try {
      let text = "";
      session.events((event) => { if (event.kind === "tool_call_ended") { text += JSON.stringify(event.content); } });
      await expect(runTurn(session, "hello")).resolves.toEqual({ kind: "completed" });
      expect(text).toContain("debug is true in production; application/json; [redacted]; [redacted]; [redacted]; [redacted]; [redacted]; [redacted]; http://localhost:3000");
      expect(text).not.toContain(firstKey);
      expect(text).not.toContain(password);
    } finally { await session.dispose(); }
  } finally {
    await provider.stop();
    http.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);
