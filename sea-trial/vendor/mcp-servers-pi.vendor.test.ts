import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { defineRuntime, piInstallation, piSession } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock, type LLMock, type RawProviderRequest } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { CLASH_ECHO, currentTurnSays, ECHO_SERVER, echoesReceived, echoServers, EXPECTED_ECHOES, leakedCredentials, scriptEchoes, startHttpEcho, stdioEcho, STDIO_TOKEN } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

/**
 * SessionOptions.mcpServers on the bundled pi SDK against a scripted
 * provider, as mcp-servers.vendor.test.ts does for claude and codex: the
 * model calls a stdio and an http echo server's tool, on open and on a
 * resume given them again, and the provider receives what only those
 * servers write. pi's own `mcp.json` and an extension's registration of the
 * same name are the clash cases (runtimes/pi/mcp.ts).
 */

const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });

/** The MCP tools of the provider requests that `match` picks. */
function offeredMcpTools(raw: readonly RawProviderRequest[], match: (request: RawProviderRequest) => boolean): readonly string[] {
  return [...new Set(raw.filter((request) => match(request)).flatMap((request) => {
    const tools = asRecord(request.body)?.tools;
    return Array.isArray(tools) ? tools.map((tool) => String(asRecord(tool)?.name)) : [];
  }))].filter((name) => name.startsWith("mcp__")).toSorted();
}

const mentions = (text: string) => (request: RawProviderRequest): boolean => JSON.stringify(request.body).includes(text);

function scriptPi(mock: LLMock): void {
  scriptEchoes(mock);
  mock.on({ predicate: currentTurnSays(/just answer/u) }, { content: "answered" });
}

/** The agent dir startPiAimock pinned for this process. */
function agentDir(): string {
  const dir = process.env.OAR_PI_AGENT_DIR;
  if (dir === undefined) {
    throw new Error("startPiAimock sets OAR_PI_AGENT_DIR");
  }
  return dir;
}

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi mcpServers", () => {
  test("a stdio and an http server attach, the agent calls both, and a resume attaches them again", async () => {
    const http = await startHttpEcho();
    const env = await startPiAimock(scriptPi, { captureRaw: true });
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
      const bare = await subject.startSession({ resume: session.id });
      await structuralToolRound(bare, env.mock, "please just answer");
      await bare.dispose();
      expect(echoesReceived(env.raw)).toEqual(EXPECTED_ECHOES);
      expect({
        open: offeredMcpTools(env.raw, mentions("call both echo tools")),
        resumedWithout: offeredMcpTools(env.raw, mentions("just answer")),
      }).toEqual({ open: ["mcp__echo__echo", "mcp__remote__echo"], resumedWithout: [] });
      expect(leakedCredentials(session, resumed)).toEqual([]);
    } finally {
      await env.stop();
      http.stop();
    }
  }, 180_000);

  test("pi's own mcp.json stays unloaded, so a server named like one of its entries is the session's", async () => {
    const env = await startPiAimock(scriptPi, { captureRaw: true });
    try {
      const user = { command: process.execPath, args: [ECHO_SERVER], env: { OAR_ECHO_TOKEN: "user-credential" } };
      await writeFile(path.join(agentDir(), "mcp.json"), JSON.stringify({ mcpServers: { echo: user, userecho: { ...user, exposure: "direct" } } }));
      const session = await runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [stdioEcho("echo", STDIO_TOKEN)] });
      expect(await structuralToolRound(session, env.mock, "please call the clashing echo")).toMatchInlineSnapshot(`
        [
          "request:prompt",
          "response:accepted",
          "tool_call_started:mcp__echo__echo",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
      expect(echoesReceived(env.raw)).toEqual([CLASH_ECHO]);
      expect(offeredMcpTools(env.raw, () => true)).toEqual(["mcp__echo__echo"]);
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("a name another extension registered fails the open instead of running without the session's server", async () => {
    const env = await startPiAimock(scriptPi, { captureRaw: true });
    try {
      const extensions = path.join(agentDir(), "extensions");
      await mkdir(extensions, { recursive: true });
      await writeFile(path.join(extensions, "user-echo.ts"), `export default (pi) => { pi.registerMcpServer("echo", { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(ECHO_SERVER)}], exposure: "direct" }); };\n`);
      const opening = runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [stdioEcho("echo", STDIO_TOKEN)] });
      await expect(opening).rejects.toThrow(/pi did not register the session's MCP servers: .*"echo" is already registered/u);
      await expect(opening).rejects.not.toThrow(STDIO_TOKEN);
    } finally {
      await env.stop();
    }
  }, 120_000);
});
