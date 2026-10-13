import type { LLMock } from "@copilotkit/aimock";
import { describe, expect, test } from "vitest";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, grokInstallation, grokSession, kimiInstallation, kimiSession, opencodeInstallation, opencodeSession, piInstallation, piSession, serveMcpTools, type HostTool, type Runtime } from "../../packages/oar/src/index.js";
import { namespaceMcpToolCalls, startClaudeAimock, startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { startGrokAimock, startKimiAimock, startOpencodeAimock } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { echoesReceived, echoFixtures, type EchoCall } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

/**
 * serveMcpTools (#341) on the real harnesses, against a scripted provider:
 * the host implements a tool in this test process, serves it with
 * `serveMcpTools`, and passes the returned entry in `mcpServers`. The model
 * calls it and the provider receives words only the host's handler writes, so
 * a passing test proves the runtime reached the host over the served entry,
 * with its bearer token, and handed the result back to the model.
 */

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
  readonly start: () => Promise<{ readonly env?: Readonly<Record<string, string>>; readonly mock: LLMock; readonly raw: Parameters<typeof echoesReceived>[0]; stop(): Promise<void> }>;
}

const runtime = (id: string, session: Runtime["session"], installation: NonNullable<Runtime["installation"]>): Runtime => defineRuntime({ id, session, installation });

// claude, codex and pi run in CI; opencode, kimi and grok locally (CI has no ACP aimock backend).
const backends: readonly Backend[] = [
  { id: "claude-aimock", runtime: runtime("claude-aimock", claudeSession, claudeInstallation), start: async () => startClaudeAimock(script(), { captureRaw: true }) },
  { id: "codex-aimock", runtime: runtime("codex-aimock", codexSession, codexInstallation), start: async () => startCodexAimock(script(), { captureRaw: true, rewriteResponse: namespaceMcpToolCalls }) },
  { id: "pi-aimock", runtime: runtime("pi-aimock", piSession, piInstallation), start: async () => startPiAimock(script(), { captureRaw: true }) },
  { id: "opencode-aimock", runtime: runtime("opencode-aimock", opencodeSession, opencodeInstallation), start: async () => startOpencodeAimock(script((server, text) => ({ name: `${server}_echo`, arguments: { text } }))) },
  { id: "kimi-aimock", runtime: runtime("kimi-aimock", kimiSession, kimiInstallation), start: async () => startKimiAimock(script()) },
  { id: "grok-aimock", runtime: runtime("grok-aimock", grokSession, grokInstallation), start: async () => startGrokAimock(script((server, text) => ({ name: "use_tool", arguments: { tool_name: `${server}__echo`, tool_input: { text } } }))) },
];

for (const backend of backends) {
  describe.skipIf(process.env.OAR_TEST !== backend.id)(`${backend.id} serveMcpTools`, () => {
    test("the agent calls a tool the host serves, and the bearer token stays out of the records", async () => {
      const served = await serveMcpTools({ name: "host", tools: [hostEcho] });
      const env = await backend.start();
      try {
        const session = await runtimeUnderTest(backend.runtime, env.env).startSession({ mcpServers: [served.server] });
        await structuralToolRound(session, env.mock, "please call the host tool");
        const records = JSON.stringify(session.records());
        await session.dispose();
        expect(echoesReceived(env.raw)).toEqual(["echo:host-call via=host token=served"]);
        const token = served.server.headers?.Authorization?.replace("Bearer ", "") ?? "";
        expect(token.length).toBeGreaterThan(40);
        expect(records).not.toContain(token);
      } finally {
        await env.stop();
        await served.close();
      }
    }, 120_000);
  });
}
