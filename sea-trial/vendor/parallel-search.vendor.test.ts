import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { parallelSearchMcp } from "../../experiments/parallel-search.js";
import { claudeInstallation, claudeSession, defineRuntime } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { structuralToolRound } from "./support/tool-round.js";

/** Observe the example's headers on discovery and both tool calls, through native Claude. */
describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("Parallel search example", () => {
  test("HTTP discovery, search and fetch carry the User-Agent without authorization", async () => {
    const requests: { method: unknown; tool: unknown; userAgent: string | undefined; authorization: string | undefined }[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const message = asRecord(JSON.parse(body));
        const params = asRecord(message?.params);
        requests.push({ method: message?.method, tool: params?.name, userAgent: request.headers["user-agent"], authorization: request.headers.authorization });
        if (message?.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "parallel-fixture", version: "1.0" } }
          : (message.method === "tools/list"
            ? { tools: ["web_search", "web_fetch"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) }
            : { content: [{ type: "text", text: `fixture:${String(params?.name)} https://nodejs.org/en/about/previous-releases` }] });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    expect(address).not.toBeNull();
    if (address === null || typeof address === "string") {
      throw new Error(`Unexpected fixture address: ${JSON.stringify(address)}`);
    }
    const configDir = await mkdtemp(`${tmpdir()}/oar-parallel-example-`);
    const env = await startClaudeAimock((mock) => {
      mock.on({ hasToolResult: false }, { toolCalls: [{ name: "mcp__parallel__web_search", arguments: "{}", id: "parallel_search" }] });
      mock.on({ hasToolResult: true, toolCallId: "parallel_search" }, { toolCalls: [{ name: "mcp__parallel__web_fetch", arguments: "{}", id: "parallel_fetch" }] });
      mock.on({ hasToolResult: true, toolCallId: "parallel_fetch" }, { content: "sources received" });
    }, { captureRaw: true });
    try {
      expect(parallelSearchMcp.url).toBe("https://search.parallel.ai/mcp");
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, { ...env.env, CLAUDE_CONFIG_DIR: configDir }).startSession({
        mcpServers: [{ ...parallelSearchMcp, url: `http://127.0.0.1:${String(address.port)}/mcp` }],
      });
      try {
        expect(await structuralToolRound(session, env.mock, "Research the Node.js release schedule")).toEqual([
          "request:prompt", "response:accepted", "tool_call_started:mcp__parallel__web_search", "tool_call_ended",
          "tool_call_started:mcp__parallel__web_fetch", "tool_call_ended", "turn_ended:completed",
        ]);
        const provider = JSON.stringify(env.raw);
        expect(provider).toContain("fixture:web_search https://nodejs.org/en/about/previous-releases");
        expect(provider).toContain("fixture:web_fetch https://nodejs.org/en/about/previous-releases");
        const relevant = requests.filter((entry) => ["initialize", "tools/list", "tools/call"].includes(String(entry.method)));
        expect(relevant.map((entry) => entry.method)).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
        expect(relevant.filter((entry) => entry.method === "tools/call").map((entry) => entry.tool)).toEqual(["web_search", "web_fetch"]);
        for (const entry of relevant) {
          expect(entry.userAgent).toBe(parallelSearchMcp.headers["User-Agent"]);
          expect(entry.authorization).toBeUndefined();
        }
      } finally {
        await session.dispose();
      }
    } finally {
      await env.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) { resolve(); } else { reject(error); } }); });
      await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }, 120_000);
});
