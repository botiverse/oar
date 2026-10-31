/** Local streamable HTTP MCP with session-specific identities and an audited call journal. */
/* oxlint-disable promise/prefer-await-to-callbacks -- Adapt the HTTP server close callback into the awaited completion. */
import { once } from "node:events";
import assert from "node:assert/strict";
import http from "node:http";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import type { McpInvocation } from "./mcp-scope.js";

export async function scopedHttpMcp(): Promise<{ readonly url: (label: string) => string; readonly calls: () => readonly McpInvocation[]; readonly stop: () => Promise<void> }> {
  const calls: McpInvocation[] = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    request.on("data", (part: Buffer) => { chunks.push(part); });
    request.on("end", () => {
      try {
        const message = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8"))); assert.ok(message !== null);
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        let result: JsonRecord = {};
        if (message.method === "initialize") { result = { protocolVersion: asRecord(message.params)?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "scope", version: "1" } }; }
        if (message.method === "tools/list") { result = { tools: [{ name: "echo", description: "Return the configured marker", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }; }
        if (message.method === "tools/call") {
          const label = request.url?.slice(1); const input = asRecord(asRecord(message.params)?.arguments)?.text;
          assert.ok(typeof label === "string" && typeof input === "string");
          const output = `MCP_RESULT=${label} input=${input}`; calls.push({ server: label, input, output }); result = { content: [{ type: "text", text: output }] };
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      } catch { response.writeHead(400).end(); }
    });
  });
  const listening = once(server, "listening"); server.listen(0, "127.0.0.1"); await listening;
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  return { url: label => `http://127.0.0.1:${address.port}/${label}`, calls: () => [...calls],
    stop: async () => { server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(error => { if (error === undefined) { closed.resolve(); } else { closed.reject(error); } }); await closed.promise; } };
}
