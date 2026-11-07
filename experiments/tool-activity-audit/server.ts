import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const [journal = "mcp.jsonl", delayMs = "2000"] = process.argv.slice(2);
const note = (kind: string, extra = {}): void => { appendFileSync(journal, `${JSON.stringify({ at: Date.now(), kind, ...extra })}\n`); };
const send = (id: unknown, result: unknown): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); };
note("process_started");
// oxlint-disable-next-line eslint/max-statements -- One tiny MCP peer records the order of its three operations.
async function handle(line: string): Promise<void> {
  const request: unknown = JSON.parse(line);
  if (!record(request)) { return; }
  const params = record(request.params) ? request.params : {};
  note("request", { method: request.method });
  if (request.id === undefined) { return; }
  if (request.method === "initialize") {
    send(request.id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "audit", version: "1.0.0" } });
    note("initialized");
  } else if (request.method === "tools/list") {
    await delay(Number(delayMs));
    send(request.id, { tools: [{ name: "echo", description: "Echo the audit text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
    note("tools_list_returned");
  } else if (request.method === "tools/call") {
    note("tool_called", { name: params.name, arguments: params.arguments });
    const args = record(params.arguments) ? params.arguments : {};
    send(request.id, { content: [{ type: "text", text: `AUDIT_MCP:${String(args.text)}` }] });
  } else if (request.method === "ping") { send(request.id, {}); }
  else { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32_601, message: "Unknown method" } })}\n`); }
}
async function receive(line: string): Promise<void> {
  try { await handle(line); }
  catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
}
createInterface({ input: process.stdin }).on("line", line => { void receive(line); });
