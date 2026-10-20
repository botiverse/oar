import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { claudeInstallation, claudeSession, serveMcpTools, type HostTool } from "../../packages/oar/src/index.js";
import { startClaudeAimock, type LLMock } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";
import { claudeMcpCatalog, claudePromptRequest, claudeToolResultRequest, claudeToolResult as resultOf } from "./support/claude-tools.js";
import { currentTurnSays } from "./support/echo-mcp.js";
import { ALPHA, BETA, SERVER, loggingProxy } from "./support/tools-list-changed.js";

const UNUSED = "oar_probe_unused";
const nameOf = (name: string): string => `mcp__${SERVER}__${name}`;

function script(mock: LLMock): void {
  for (const [round, names, called] of [
    ["ALPHA", [ALPHA], ALPHA],
    ["BETA", [BETA], BETA],
    ["REMOVED", [ALPHA, UNUSED], ALPHA],
  ] as const) {
    mock.on({ predicate: currentTurnSays(new RegExp(`${round}_ROUND`, "u")), hasToolResult: false }, {
      toolCalls: [{ id: `search_${round}`, name: "ToolSearch", arguments: JSON.stringify({ query: `select:${names.map((name) => nameOf(name)).join(",")}`, max_results: 5 }) }],
    });
    mock.on({ hasToolResult: true, toolCallId: `search_${round}` }, {
      toolCalls: [{ id: `call_${round}`, name: nameOf(called), arguments: "{}" }],
    });
    mock.on({ hasToolResult: true, toolCallId: `call_${round}` }, { content: "ok" });
  }
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude deferred MCP tools", () => {
  test("search loads callable schemas; replacement withdraws search results but retains a previously loaded definition", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-tool-search-"));
    const calls: string[] = [];
    const tool = (name: string): HostTool => ({
      name, description: `Probe ${name}.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => { calls.push(name); return `HANDLER_RESULT:${name}`; },
    });
    const env = await startClaudeAimock(script, { captureRaw: true });
    const served = await serveMcpTools({ name: SERVER, tools: [tool(ALPHA), tool(UNUSED)] });
    const log: string[] = [];
    const proxy = await loggingProxy(served, log);
    try {
      // Keep the native default. Since 2.1.304 a custom base URL uses tool
      // search too; disabling it here would hide the user's normal path.
      const installation = await claudeInstallation();
      expectAvailable(installation, "claude");
      const session = await claudeSession(installation, {
        cwd: directory, env: { ...env.env, CLAUDE_CONFIG_DIR: directory },
        mcpServers: [{ name: SERVER, type: "http", url: proxy.url }],
      });
      try {
        expect(await runTurn(session, "ALPHA_ROUND")).toEqual({ kind: "completed" });
        expect(claudeMcpCatalog(claudePromptRequest(env.raw, "ALPHA_ROUND"))).toEqual({ schemas: [], searchable: [nameOf(ALPHA), nameOf(UNUSED)] });
        expect(resultOf(env.raw, "search_ALPHA")).toEqual([{ type: "tool_reference", tool_name: nameOf(ALPHA) }]);
        expect(resultOf(env.raw, "call_ALPHA")).toEqual([{ type: "text", text: `HANDLER_RESULT:${ALPHA}` }]);
        expect(claudeMcpCatalog(claudeToolResultRequest(env.raw, "call_ALPHA")).schemas).toEqual([nameOf(ALPHA)]);
        expect(calls).toEqual([ALPHA]);

        const changedAt = log.length;
        served.setTools([tool(BETA)]);
        await vi.waitFor(() => { expect(log.slice(changedAt)).toContain("tools/list"); }, { timeout: 10_000 });
        expect(await runTurn(session, "BETA_ROUND")).toEqual({ kind: "completed" });
        // The native removal announcement overrides the old searchable list.
        // The already loaded alpha schema stays in tools; unused never did.
        expect(claudeMcpCatalog(claudePromptRequest(env.raw, "BETA_ROUND"))).toEqual({ schemas: [nameOf(ALPHA)], searchable: [nameOf(BETA)] });
        expect(resultOf(env.raw, "search_BETA")).toEqual([{ type: "tool_reference", tool_name: nameOf(BETA) }]);
        expect(resultOf(env.raw, "call_BETA")).toEqual([{ type: "text", text: `HANDLER_RESULT:${BETA}` }]);
        expect(claudeMcpCatalog(claudeToolResultRequest(env.raw, "call_BETA")).schemas).toEqual([nameOf(ALPHA), nameOf(BETA)]);

        expect(await runTurn(session, "REMOVED_ROUND")).toEqual({ kind: "completed" });
        expect(resultOf(env.raw, "search_REMOVED")).toBe("No matching deferred tools found");
        expect(resultOf(env.raw, "call_REMOVED")).toMatchInlineSnapshot(`"<tool_use_error>Error: No such tool available: mcp__probe__oar_probe_alpha. Its MCP server 'probe' is connected but does not offer this tool here. Continue without it.</tool_use_error>"`);
        expect(calls).toEqual([ALPHA, BETA]);
      } finally {
        await session.dispose();
      }
    } finally {
      await proxy.close();
      await served.close();
      await env.stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }, 120_000);
});
