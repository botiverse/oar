import { isOpencodeV2Aimock } from "./support/opencode-version.js";
import { piTestRuntime } from "./support/pi-runtime.js";
import { describe, expect, test } from "vitest";
import { claudeInstallation, defineRuntime, serveMcpTools, type HostTool, type Runtime, claudeRuntime, codexRuntime, grokRuntime, kimiRuntime, opencodeRuntime, piRuntime } from "../../packages/oar/src/index.js";

import { namespaceMcpToolCalls, startClaudeAimock, startCodexAimock, startPiAimock, type LLMock } from "../harness/aimock.js";
import { startOpencodeGitFixture, startGrokAimock, startKimiAimock } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { codeModeEcho, echoesReceived, echoFixtures, type EchoCall } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";
import { record } from "../harness/trace.js";

const opencodeV2 = await isOpencodeV2Aimock();

const claudeSession = claudeRuntime.session;
const codexInstallation = codexRuntime.installation;
const codexSession = codexRuntime.session;
const grokInstallation = grokRuntime.installation;
const grokSession = grokRuntime.session;
const kimiInstallation = kimiRuntime.installation;
const kimiSession = kimiRuntime.session;
const opencodeInstallation = opencodeRuntime.installation;
const opencodeSession = opencodeRuntime.session;
const piInstallation = piRuntime.installation;
const piSession = piRuntime.session;

/**
 * serveMcpTools (#341) on the real harnesses, against a scripted provider:
 * the host implements a tool in this test process, serves it with
 * `serveMcpTools`, and passes the returned entry in `mcpServers`. The model
 * calls it and the provider receives words only the host's handler writes, so
 * a passing test proves the runtime reached the host over the served entry,
 * with its bearer token, and handed the result back to the model.
 */

const INSTRUCTIONS = "OAR-HOST-INSTRUCTIONS-7f3a: call echo before anything else.";

const hostEcho: HostTool = {
  name: "echo",
  description: "Echo the given text back, prefixed with echo:",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  handler: (input) => `echo:${String(input.text)} via=host token=served`,
};

/** The model's call to the host tool, the runtime's way (see mcp-servers-acp.vendor.test.ts for the ACP shapes). */
const script = (call?: EchoCall) => (mock: LLMock): void => {
  echoFixtures(mock, /call the host tool/u, [{ server: "host", text: "host-call" }], call);
};

interface Backend {
  readonly id: string;
  readonly runtime: Runtime;
  /** Whether the runtime hands the server's `instructions` to the model ([env] 2026-10-13: claude 2.1.292, codex 0.162.0, opencode 1.18.30, grok 1.0.50 do; pi 1.1.0 and kimi 2.1.1 do not). */
  readonly instructions: boolean;
  readonly codeMode?: true;
  readonly start: () => Promise<{ readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly mock: LLMock; readonly raw: Parameters<typeof echoesReceived>[0]; stop(): Promise<void> }>;
}

const runtime = (id: string, session: Runtime["session"], installation: NonNullable<Runtime["installation"]>): Runtime => defineRuntime({ id, session, installation });

// CI runs claude, codex, pi, OpenCode v1, kimi and grok with local scripted providers.
const backends: readonly Backend[] = [
  { id: "claude-aimock", runtime: runtime("claude-aimock", claudeSession, claudeInstallation), instructions: true, start: async () => startClaudeAimock(script(), { captureRaw: true }) },
  { id: "codex-aimock", runtime: runtime("codex-aimock", codexSession, codexInstallation), instructions: true, start: async () => startCodexAimock(script(), { captureRaw: true, rewriteResponse: namespaceMcpToolCalls }) },
  { id: "pi-aimock", runtime: runtime("pi-aimock", piSession, piInstallation), instructions: false, start: async () => startPiAimock(script(), { captureRaw: true }) },
  { id: "pi-rpc-aimock", runtime: piTestRuntime, instructions: false, start: async () => startPiAimock(script(), { captureRaw: true }) },
  { id: "opencode-aimock", runtime: runtime("opencode-aimock", opencodeSession, opencodeInstallation), instructions: true, start: async () => startOpencodeGitFixture(script((server, text) => ({ name: `${server}_echo`, arguments: { text } }))) },
  { id: "opencode-aimock", runtime: opencodeRuntime, instructions: true, codeMode: true, start: async () => startOpencodeGitFixture(script(codeModeEcho)) },
  { id: "kimi-aimock", runtime: runtime("kimi-aimock", kimiSession, kimiInstallation), instructions: false, start: async () => startKimiAimock(script()) },
  { id: "grok-aimock", runtime: runtime("grok-aimock", grokSession, grokInstallation), instructions: true, start: async () => startGrokAimock(script((server, text) => ({ name: "use_tool", arguments: { tool_name: `${server}__echo`, tool_input: { text } } }))) },
];

for (const backend of backends) {
  describe.skipIf(process.env.OAR_TEST !== backend.id || (backend.codeMode === true && !opencodeV2))(`${backend.id}${backend.codeMode === true ? " Code Mode" : ""} serveMcpTools`, () => {
    test("the agent calls a tool the host serves, and the bearer token stays out of the records", async context => {
      if (opencodeV2 && backend.codeMode !== true) { context.skip("This fixture scripts host_echo as a direct tool. OpenCode v2 calls the host through Code Mode execute."); }
      const served = await serveMcpTools({ name: "host", tools: [hostEcho], instructions: INSTRUCTIONS });
      const env = await backend.start();
      let phase = "opening";
      const progress = process.env.OAR_TEST_MCP_PROGRESS === "1" ? setInterval(() => {
        record({ kind: "served_mcp_progress", backend: backend.id, phase, providerRequests: env.raw.length });
      }, 10_000).unref() : undefined;
      try {
        const opening = runtimeUnderTest(backend.runtime, env.env, env.cwd).startSession({ mcpServers: [served.server] });
        if (backend.id === "pi-rpc-aimock" || (backend.id === "claude-aimock" && process.platform === "win32")) {
          await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
          return;
        }
        const session = await opening;
        try {
          phase = "tool_turn";
          await structuralToolRound(session, env.mock, "please call the host tool");
        } finally {
          phase = "dispose";
          await session.dispose();
        }
        const records = JSON.stringify(session.records());
        expect(echoesReceived(env.raw)).toEqual(["echo:host-call via=host token=served"]);
        // The runtime decides whether the server's instructions reach the model (#378).
        expect(env.raw.some((request) => JSON.stringify(request.body).includes(INSTRUCTIONS))).toBe(backend.instructions);
        const token = served.server.headers?.Authorization?.replace("Bearer ", "") ?? "";
        expect(token.length).toBeGreaterThan(40);
        expect(records.includes(token)).toBe(false);
      } finally {
        phase = "fixture_cleanup";
        if (progress !== undefined) { clearInterval(progress); }
        await env.stop();
        await served.close();
      }
    }, 120_000);
  });
}
