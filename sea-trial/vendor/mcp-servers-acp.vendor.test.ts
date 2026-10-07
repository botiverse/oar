import { describe, expect, test } from "vitest";
import type { InstallationProbe } from "../../packages/oar/src/contracts/installation.js";
import type { McpServer, StartSession } from "../../packages/oar/src/contracts/session.js";
import { antigravityInstallation, antigravitySession, defineRuntime, grokInstallation, grokSession, kimiInstallation, kimiSession, opencodeInstallation, opencodeSession } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import type { LLMock, RawProviderRequest } from "../harness/aimock.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock, type AcpAimockEnv } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { currentTurnSays, ECHO_SERVER, echoesReceived, echoFixtures, echoServers, EXPECTED_ECHOES, fingerprint, leakedCredentials, scriptEchoes, startHttpEcho, stdioEcho, STDIO_TOKEN, type EchoCall } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

/**
 * SessionOptions.mcpServers on the ACP runtimes that attach them (ACP
 * `session/new` / `session/resume` `mcpServers`, shared/acp/mcp-servers.ts),
 * each the REAL CLI against a scripted provider (harness/aimock-acp.ts), as
 * mcp-servers.vendor.test.ts does for claude and codex: the model calls a
 * stdio and an http echo server's tool, on open and on a resume given them
 * again, and the provider receives what only those servers write. On a name
 * clash with a server of the user's own configuration, the model calls the
 * session's `echo` and the user's other server: which credential each echo
 * carries says which server answered. No record may hold a credential.
 */

const USER_TOKEN = "oar-user-credential";

interface AcpCase {
  readonly id: string;
  readonly session: StartSession;
  readonly installation: InstallationProbe;
  /** How the model calls a server's echo tool on this runtime. */
  readonly call: EchoCall;
  /** The tool oar reports for the call to `echo` and the one to `remote` (the ACP tool_call's title). */
  readonly reported: readonly [string, string];
  /** The scripted environment, with a user config holding `echo` and `userecho` (the stdio echo server with USER_TOKEN) when `withUserServers`. */
  start(configure: (mock: LLMock) => void, withUserServers: boolean): Promise<AcpAimockEnv>;
  /** The MCP tools one provider request offers, where the runtime declares them as tools of their own. */
  readonly offered?: (request: RawProviderRequest) => readonly string[];
}

const userServer = { command: process.execPath, args: [ECHO_SERVER], env: { OAR_ECHO_TOKEN: USER_TOKEN } };

const toolNames = (request: RawProviderRequest): readonly string[] => {
  const tools = asRecord(request.body)?.tools;
  return Array.isArray(tools) ? tools.map((tool) => String(asRecord(tool)?.name ?? asRecord(asRecord(tool)?.function)?.name)) : [];
};

const cases: readonly AcpCase[] = [
  {
    // opencode names a server's tool `<server>_<tool>`.
    id: "opencode-aimock",
    session: opencodeSession,
    installation: opencodeInstallation,
    call: (server, text) => ({ name: `${server}_echo`, arguments: { text } }),
    reported: ["echo_echo", "remote_echo"],
    start: async (configure, withUserServers) => startOpencodeAimock(configure, withUserServers
      ? { mcp: Object.fromEntries(["echo", "userecho"].map((name) => [name, { type: "local", command: [userServer.command, ...userServer.args], environment: userServer.env }])) }
      : {}),
    offered: (request) => toolNames(request).filter((name) => /^(?:echo|remote|userecho)_echo$/u.test(name)),
  },
  {
    id: "kimi-aimock",
    session: kimiSession,
    installation: kimiInstallation,
    call: (server, text) => ({ name: `mcp__${server}__echo`, arguments: { text } }),
    reported: ["mcp__echo__echo", "mcp__remote__echo"],
    start: async (configure, withUserServers) => startKimiAimock(configure, withUserServers ? { mcpServers: { echo: userServer, userecho: userServer } } : undefined),
    offered: (request) => toolNames(request).filter((name) => name.startsWith("mcp__")),
  },
  {
    // grok declares no MCP tool to the model: it calls them through its
    // `use_tool` meta-tool, named `<server>__<tool>`.
    id: "grok-aimock",
    session: grokSession,
    installation: grokInstallation,
    call: (server, text) => ({ name: "use_tool", arguments: { tool_name: `${server}__echo`, tool_input: { text } } }),
    reported: ["use_tool", "use_tool"],
    start: async (configure, withUserServers) => startGrokAimock(configure, withUserServers
      ? ["echo", "userecho"].map((name) => [`[mcp_servers.${name}]`, `command = ${JSON.stringify(userServer.command)}`, `args = ${JSON.stringify(userServer.args)}`, `env = { OAR_ECHO_TOKEN = ${JSON.stringify(USER_TOKEN)} }`].join("\n")).join("\n")
      : ""),
  },
  {
    // antigravity lists a server's tools in its system prompt and calls them
    // through its `call_mcp_tool` tool. Run with OAR_ANTIGRAVITY_BIN naming
    // an agy_acp_server.par with its localharness_external beside it.
    id: "antigravity-aimock",
    session: antigravitySession,
    installation: antigravityInstallation,
    call: (server, text) => ({ name: "call_mcp_tool", arguments: { ServerName: server, ToolName: "echo", Arguments: { text }, toolSummary: "Echo the text", toolAction: "Echoing" } }),
    // Its tool_call title is "Running <tool>".
    reported: ["Running echo", "Running echo"],
    start: async (configure, withUserServers) => startAntigravityAimock(configure, withUserServers ? { mcpServers: { echo: userServer, userecho: userServer } } : undefined),
  },
];

for (const acp of cases) {
  describe.skipIf(process.env.OAR_TEST !== acp.id)(`${acp.id} mcpServers`, () => {
    const runtime = defineRuntime({ id: acp.id, session: acp.session, installation: acp.installation });
    const script = (mock: LLMock): void => {
      scriptEchoes(mock, acp.call);
      echoFixtures(mock, /call echo over the user's own/u, [{ server: "echo", text: "clash-own" }, { server: "userecho", text: "clash-user" }], acp.call);
      mock.on({ predicate: currentTurnSays(/just answer/u) }, { content: "answered" });
    };

    test("a stdio and an http server attach, the agent calls both, and a resume attaches them again", async () => {
      const http = await startHttpEcho();
      const env = await acp.start(script, false);
      try {
        const subject = runtimeUnderTest(runtime, env.env);
        const mcpServers: readonly McpServer[] = echoServers(http.url);
        const session = await subject.startSession({ mcpServers });
        const opened = await structuralToolRound(session, env.mock, "please call both echo tools");
        await session.dispose();
        const resumed = await subject.startSession({ resume: session.id, mcpServers });
        const again = await structuralToolRound(resumed, env.mock, "please call the echo tool again");
        await resumed.dispose();
        const bare = await subject.startSession({ resume: session.id });
        await structuralToolRound(bare, env.mock, "please just answer");
        await bare.dispose();
        const [echo, remote] = acp.reported;
        expect({ opened, again }).toEqual({
          opened: ["request:prompt", "response:accepted", `tool_call_started:${echo}`, "tool_call_ended", `tool_call_started:${remote}`, "tool_call_ended", "turn_ended:completed"],
          again: ["request:prompt", "response:accepted", `tool_call_started:${echo}`, "tool_call_ended", "turn_ended:completed"],
        });
        expect(echoesReceived(env.raw)).toEqual(EXPECTED_ECHOES);
        if (acp.offered !== undefined) {
          const { offered: tools } = acp;
          const offered = (text: string): readonly string[] => [...new Set(env.raw.filter((request) => JSON.stringify(request.body).includes(text)).flatMap((request) => tools(request)))].toSorted();
          expect({ opened: offered("call both echo tools"), resumedWithout: offered("just answer") }).toEqual({ opened: [echo, remote], resumedWithout: [] });
        }
        expect(leakedCredentials(session, resumed)).toEqual([]);
      } finally {
        await env.stop();
        http.stop();
      }
    }, 240_000);

    test("a server named like one of the user's runs as the session's; the user's other servers stay", async () => {
      const env = await acp.start(script, true);
      try {
        const session = await runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [stdioEcho("echo", STDIO_TOKEN)] });
        await structuralToolRound(session, env.mock, "please call echo over the user's own");
        await session.dispose();
        expect(echoesReceived(env.raw)).toEqual([
          `echo:clash-own via=stdio token=${fingerprint(STDIO_TOKEN)}`,
          `echo:clash-user via=stdio token=${fingerprint(USER_TOKEN)}`,
        ]);
        expect(leakedCredentials(session)).toEqual([]);
      } finally {
        await env.stop();
      }
    }, 180_000);
  });
}
