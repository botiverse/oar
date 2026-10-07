import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, type McpServer, type RawEvent, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { namespaceMcpToolCalls, startClaudeAimock, startCodexAimock, type LLMock, type RawProviderRequest } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { ECHO_SERVER, echoesReceived, echoFixtures, fingerprint, startHttpEcho, stdioEcho } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

/**
 * SessionOptions.mcpServers on the real harness, against a scripted provider:
 * the model calls the echo server's tool (tests/fixtures/echo-mcp-server.mjs)
 * and the provider receives what only that server writes, `echo:<text>
 * via=<transport> token=<fingerprint of the credential it was given>`. So a
 * passing test proves the runtime started (or connected to) the server, its
 * credential reached it, and its result went back to the model; on open and
 * on a resume, which remembers no server and is given them again. Neither
 * credential value may appear anywhere in the session's records.
 */

const STDIO_TOKEN = "oar-stdio-credential";
const HTTP_AUTHORIZATION = "Bearer oar-http-credential";

/** Both secrets, checked absent from every record of every session. */
function leakedCredentials(...sessions: readonly Session[]): readonly string[] {
  const records = JSON.stringify(sessions.flatMap((session) => session.records()));
  return [STDIO_TOKEN, HTTP_AUTHORIZATION, "oar-http-credential"].filter((secret) => records.includes(secret));
}

/** The servers the http echo listens on and the stdio one. */
function echoServers(url: string): readonly McpServer[] {
  return [stdioEcho("echo", STDIO_TOKEN), { name: "remote", type: "http", url, headers: { Authorization: HTTP_AUTHORIZATION } }];
}

const BOTH = [{ server: "echo", text: "stdio-call" }, { server: "remote", text: "http-call" }];
const AGAIN = [{ server: "echo", text: "resumed-call" }];

function scriptEchoes(mock: LLMock): void {
  echoFixtures(mock, /call both echo tools/u, BOTH);
  echoFixtures(mock, /call the echo tool again/u, AGAIN);
  echoFixtures(mock, /call the clashing echo/u, [{ server: "echo", text: "clash-call" }]);
}

/** What the open and the resume each received: one echo per call, carrying the credential each server was given. */
const EXPECTED_ECHOES = [
  `echo:stdio-call via=stdio token=${fingerprint(STDIO_TOKEN)}`,
  `echo:http-call via=http token=${fingerprint(HTTP_AUTHORIZATION)}`,
  `echo:resumed-call via=stdio token=${fingerprint(STDIO_TOKEN)}`,
];

/** A user-scope stdio echo server in claude's own config (`.claude.json`), with a credential of its own. */
const CLAUDE_USER_SERVER = { type: "stdio", command: process.execPath, args: [ECHO_SERVER], env: { OAR_ECHO_TOKEN: "user-credential" } };

/** claude's system/init report of its MCP servers (`mcp_servers`), from the session's first init frame. */
function claudeServerReport(records: readonly RawEvent[]): unknown {
  const init = records.find((entry) => entry.kind === "frame" && asRecord(entry.body.native)?.type === "system" && asRecord(entry.body.native)?.subtype === "init");
  return init?.kind === "frame" ? asRecord(init.body.native)?.mcp_servers : undefined;
}

/** Each provider request's tool names: codex offers an MCP server as one `namespace` tool, `mcp__<server>`. */
function offeredTools(raw: readonly RawProviderRequest[]): readonly string[] {
  return [...new Set(raw.flatMap((request) => {
    const tools = asRecord(request.body)?.tools;
    return Array.isArray(tools) ? tools.map((tool) => String(asRecord(tool)?.name)) : [];
  }))].toSorted();
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude mcpServers", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("a stdio and an http server attach, the agent calls both, and a resume attaches them again", async () => {
    const http = await startHttpEcho();
    const env = await startClaudeAimock(scriptEchoes, { captureRaw: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const mcpServers = echoServers(http.url);
      const session = await subject.startSession({ mcpServers });
      expect(await structuralToolRound(session, env.mock, "please call both echo tools")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "tool_call_started:mcp__remote__echo",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      expect(claudeServerReport(session.records())).toMatchInlineSnapshot(`
        [
          {
            "name": "echo",
            "source": "dynamic",
            "status": "connected",
          },
          {
            "name": "remote",
            "source": "dynamic",
            "status": "connected",
          },
        ]
      `);
      await session.dispose();
      const resumed = await subject.startSession({ resume: session.id, mcpServers });
      expect(await structuralToolRound(resumed, env.mock, "please call the echo tool again")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await resumed.dispose();
      expect(echoesReceived(env.raw)).toEqual(EXPECTED_ECHOES);
      expect(leakedCredentials(session, resumed)).toEqual([]);
    } finally {
      await env.stop();
      http.stop();
    }
  }, 180_000);

  test("on a name clash the session's server replaces the user's own for that session; the user's others stay", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "oar-claude-config-"));
    const env = await startClaudeAimock(scriptEchoes, { captureRaw: true });
    try {
      await writeFile(path.join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { echo: CLAUDE_USER_SERVER, userecho: CLAUDE_USER_SERVER } }));
      const session = await runtimeUnderTest(runtime, { ...env.env, CLAUDE_CONFIG_DIR: configDir }).startSession({ mcpServers: [stdioEcho("echo", STDIO_TOKEN)] });
      expect(await structuralToolRound(session, env.mock, "please call the clashing echo")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      expect(claudeServerReport(session.records())).toMatchInlineSnapshot(`
        [
          {
            "name": "echo",
            "source": "dynamic",
            "status": "connected",
          },
          {
            "name": "userecho",
            "source": "user",
            "status": "connected",
          },
        ]
      `);
      await session.dispose();
      expect(echoesReceived(env.raw)).toEqual([`echo:clash-call via=stdio token=${fingerprint(STDIO_TOKEN)}`]);
    } finally {
      await env.stop();
      await rm(configDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex mcpServers", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });

  // The thread opens on gpt-5.5 while the aimock config.toml says gpt-5.1, so
  // a resume whose config override rebuilt the thread from config.toml would
  // show up as the model changing (open.ts).
  test("a stdio and an http server attach, the agent calls both, and a resume attaches them again on the thread's own model", async () => {
    const http = await startHttpEcho();
    const env = await startCodexAimock(scriptEchoes, { captureRaw: true, rewriteResponse: namespaceMcpToolCalls });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const mcpServers = echoServers(http.url);
      const session = await subject.startSession({ model: "gpt-5.5", mcpServers });
      expect(await structuralToolRound(session, env.mock, "please call both echo tools")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcpToolCall",
          "tool_call_ended",
          "tool_call_started:mcpToolCall",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
      const resumed = await subject.startSession({ resume: session.id, mcpServers });
      expect(await structuralToolRound(resumed, env.mock, "please call the echo tool again")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcpToolCall",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await resumed.dispose();
      expect(echoesReceived(env.raw)).toEqual(EXPECTED_ECHOES);
      expect({
        reported: [session.model().value, resumed.model().value],
        wire: [...new Set(env.raw.map((request) => asRecord(request.body)?.model))],
      }).toEqual({ reported: ["gpt-5.5", "gpt-5.5"], wire: ["gpt-5.5"] });
      expect(leakedCredentials(session, resumed)).toEqual([]);
    } finally {
      await env.stop();
      http.stop();
    }
  }, 180_000);

  test("on a name clash codex merges the session's server into the user's: oar's command, args and enabled win, the user's others stay", async () => {
    const env = await startCodexAimock(scriptEchoes, { captureRaw: true, rewriteResponse: namespaceMcpToolCalls });
    try {
      const home = env.env?.CODEX_HOME ?? "";
      const node = JSON.stringify(process.execPath);
      const server = JSON.stringify(ECHO_SERVER);
      // The user's echo is disabled and starts with a flag node refuses: either surviving the merge would leave the session without its server.
      await appendFile(path.join(home, "config.toml"), [
        "",
        "[mcp_servers.echo]",
        `command = ${node}`,
        `args = ["--no-such-node-flag", ${server}]`,
        "enabled = false",
        'env = { OAR_ECHO_TOKEN = "user-credential" }',
        "",
        "[mcp_servers.userecho]",
        `command = ${node}`,
        `args = [${server}]`,
        "",
      ].join("\n"));
      const session = await runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [stdioEcho("echo", STDIO_TOKEN)] });
      expect(await structuralToolRound(session, env.mock, "please call the clashing echo")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcpToolCall",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
      expect(echoesReceived(env.raw)).toEqual([`echo:clash-call via=stdio token=${fingerprint(STDIO_TOKEN)}`]);
      expect(offeredTools(env.raw).filter((name) => name.startsWith("mcp__"))).toEqual(["mcp__echo", "mcp__userecho"]);
    } finally {
      await env.stop();
    }
  }, 120_000);
});
