import { describe, expect, test } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startOpencodeGitFixture } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { codeModeEcho, currentTurnSays, echoFixtures, echoesReceived, echoServers, EXPECTED_ECHOES, fingerprint, HTTP_AUTHORIZATION, leakedCredentials, startHttpEcho } from "./support/echo-mcp.js";
import { isOpencodeV2Aimock } from "./support/opencode-version.js";
import { structuralToolRound } from "./support/tool-round.js";
import { ALPHA, BETA, lastWithTools, runToolsListChanged, SERVER } from "./support/tools-list-changed.js";

function callCatalogTool(id: string, name: string) {
  return { toolCalls: [{
    id, name: "execute", arguments: JSON.stringify({ code: `return await tools.${SERVER}.${name}();` }),
  }] };
}

describe.skipIf(!await isOpencodeV2Aimock())("OpenCode v2 Code Mode MCP", () => {
  test("session stdio and HTTP tools return their echoes on open and reattach on resume", async () => {
    const http = await startHttpEcho();
    try {
      const env = await startOpencodeGitFixture(mock => {
        echoFixtures(mock, /both echo tools/u, [{ server: "echo", text: "stdio-call" }, { server: "remote", text: "http-call" }], codeModeEcho);
        echoFixtures(mock, /reattached tools/u, [{ server: "echo", text: "resumed-call" }, { server: "remote", text: "resumed-http" }], codeModeEcho);
      });
      try {
        const subject = runtimeUnderTest(opencodeRuntime, env.env, env.cwd);
        const mcpServers = echoServers(http.url);
        const replacement = "OAR-REPLACED-PROMPT check the echo";
        const addition = "OAR-APPENDED-PROMPT keep the echo";
        const session = await subject.startSession({ mcpServers, systemPrompt: replacement, appendSystemPrompt: addition });
        try {
          await structuralToolRound(session, env.mock, "please call both echo tools");
          expect(echoesReceived(env.raw)).toEqual(EXPECTED_ECHOES.slice(0, 2));
          const system = JSON.stringify(asRecord(lastWithTools(env.raw))?.system);
          expect(system).toContain(replacement);
          expect(system).toContain(addition);
        } finally { await session.dispose(); }
        const resumed = await subject.startSession({ resume: session.id, mcpServers });
        try {
          await structuralToolRound(resumed, env.mock, "please call the reattached tools");
          expect(echoesReceived(env.raw)).toEqual([...EXPECTED_ECHOES, `echo:resumed-http via=http token=${fingerprint(HTTP_AUTHORIZATION)}`]);
        } finally { await resumed.dispose(); }
        expect(leakedCredentials(session, resumed)).toHaveLength(0);
      } finally { await env.stop(); }
    } finally { http.stop(); }
  }, 180_000);

  test("the model sees a catalog replacement and only the current tools reach the host", async () => {
    const env = await startOpencodeGitFixture(mock => {
      mock.on({ predicate: currentTurnSays(/first turn/u), hasToolResult: false }, callCatalogTool("original", ALPHA));
      mock.on({ toolCallId: "original", hasToolResult: true }, { content: "ok" });
      mock.on({ predicate: currentTurnSays(/second turn/u), hasToolResult: false }, callCatalogTool("withdrawn", ALPHA));
      mock.on({ toolCallId: "withdrawn", hasToolResult: true }, callCatalogTool("added", BETA));
      mock.on({ toolCallId: "added", hasToolResult: true }, { content: "ok" });
    });
    try {
      const subject = runtimeUnderTest(opencodeRuntime, env.env, env.cwd);
      const run = await runToolsListChanged(env, async server => subject.startSession({ mcpServers: [server] }));
      expect(run.connected).toBe(true);
      expect(run.relisted).toBe(true);
      expect(run.log.filter(method => method === "tools/call" || method === "setTools")).toEqual(["tools/call", "setTools", "tools/call"]);
      expect(run.calls).toEqual([ALPHA, BETA]);
      const [before, after] = run.turns.map(turn => asRecord(lastWithTools(turn)));
      expect(JSON.stringify(before?.system)).toContain(`tools.${SERVER}.${ALPHA}()`);
      expect(JSON.stringify(before?.system)).not.toContain(BETA);
      const messages = JSON.stringify(after?.messages);
      expect(messages).toContain(`tools.${SERVER}.${BETA}(): Promise`);
      expect(messages).toContain(`no longer available and must not be called: tools.${SERVER}.${ALPHA}`);
      expect(messages).toContain(`Unknown tool '${SERVER}.${ALPHA}'`);
      expect(messages).toContain(`handled:${BETA}`);
      expect(opencodeRuntime.mcpToolsListChanged).toBe("full");
    } finally { await env.stop(); }
  }, 120_000);
});
