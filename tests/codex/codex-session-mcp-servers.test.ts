import { afterEach, expect, test, vi } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { codexThreadOpen } from "../../packages/oar/src/runtimes/codex/open.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.160.1" } as const;

const STDIO_TOKEN = "stdio-secret-value";
const HEADER = "Bearer header-secret-value";
const echo: McpServer = { name: "echo", command: "/usr/bin/node", args: ["echo.mjs"], env: { OAR_ECHO_TOKEN: STDIO_TOKEN } };
const remote: McpServer = { name: "remote.v2", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: HEADER } };

afterEach(() => {
  spawnLineProcess.mockReset();
});

test("thread/start and thread/resume both carry the servers as one mcp_servers config table", () => {
  const start = codexThreadOpen({ cwd: "/work", effort: "low", mcpServers: [echo, remote, { name: "bare", command: "bare-server" }] });
  expect(start.params.config).toMatchInlineSnapshot(`
    {
      "mcp_servers": {
        "bare": {
          "args": [],
          "command": "bare-server",
          "enabled": true,
        },
        "echo": {
          "args": [
            "echo.mjs",
          ],
          "command": "/usr/bin/node",
          "enabled": true,
          "env": {
            "OAR_ECHO_TOKEN": "stdio-secret-value",
          },
        },
        "remote.v2": {
          "enabled": true,
          "http_headers": {
            "Authorization": "Bearer header-secret-value",
          },
          "url": "http://127.0.0.1:9/mcp",
        },
      },
      "model_reasoning_effort": "low",
    }
  `);
  // A resume takes no effort override (open.ts) but the servers again.
  const resume = codexThreadOpen({ cwd: "/work", resume: "thread-1", effort: "low", mcpServers: [echo] });
  expect(resume.method).toBe("thread/resume");
  expect(Object.keys(asRecord(resume.params.config) ?? {})).toEqual(["mcp_servers"]);
  // None given, or an empty list: no config at all.
  expect(codexThreadOpen({ cwd: "/work", mcpServers: [] }).params).not.toHaveProperty("config");
  expect(codexThreadOpen({ cwd: "/work", resume: "thread-1" }).params).not.toHaveProperty("config");
});

test("a name codex would refuse to start, or one given twice, fails the open before codex starts", async () => {
  await expect(codexSession(installation, { cwd: "/work", mcpServers: [{ name: "my server", command: "x" }] })).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: codex starts no MCP server named "my server": its names match ^[\\w:@/.-]+$]`);
  await expect(codexSession(installation, { cwd: "/work", mcpServers: [echo, echo] })).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: mcpServers names "echo" twice; names are unique within a session]`);
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("an open failure never carries an env or header value, however codex words it", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number") {
      return;
    }
    const reply = message.method === "initialize"
      ? { result: {} }
      : { error: { code: -32_600, message: `bad config: env ${STDIO_TOKEN}, header ${HEADER}` } };
    process.emit(`${JSON.stringify({ id: message.id, ...reply })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(codexSession(installation, { cwd: "/work", mcpServers: [echo, remote] })).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: codex thread/start failed: bad config: env [redacted], header [redacted]]`);
});

test("nor does a codex exit, whose stderr tail the error carries", async () => {
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (message?.method === "initialize") {
      process.emitStderr(`failed to start server with ${STDIO_TOKEN}\n`);
      process.end(1);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const opening = codexSession(installation, { cwd: "/work", mcpServers: [echo] });
  await expect(opening).rejects.toThrow(/\[redacted\]/u);
  await expect(opening).rejects.not.toThrow(STDIO_TOKEN);
});
