import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;

interface PendingElicitation {
  readonly toolCallId: string | number;
  readonly mode: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function parseRecord(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function send(payload: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function elicitationParams(mode: string, index: number): JsonRecord {
  if (mode === "url") {
    return {
      mode: "url",
      message: "Sign in to continue",
      elicitationId: `elicit-url-${String(index)}`,
      url: "https://example.invalid/oauth",
    };
  }
  return {
    mode: "form",
    message: "Enter your name",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  };
}

function extractAction(message: JsonRecord): string {
  const result = asRecord(message.result);
  if (typeof result?.action === "string") {
    return result.action;
  }
  const error = asRecord(message.error);
  if (error !== null) {
    return `error:${String(error.code)}`;
  }
  return "unknown";
}

function handleInitialize(params: JsonRecord): JsonRecord {
  const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "oar-elicit", version: "1.0.0" },
  };
}

function handleToolsList(): JsonRecord {
  return {
    tools: [{
      name: "ask",
      description: "Request an MCP elicitation before answering",
      inputSchema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
    }],
  };
}

const pending = new Map<string, PendingElicitation>();
let nextElicitId = 0;

function startElicitation(id: string | number, params: JsonRecord): void {
  const args = asRecord(params.arguments);
  const mode = args?.mode === "url" ? "url" : "form";
  nextElicitId += 1;
  const elicitId = `elicit-${String(nextElicitId)}`;
  const timer = setTimeout(() => {
    if (!pending.delete(elicitId)) {
      return;
    }
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `elicit:${mode} action=timeout` }] } });
  }, 12_000);
  pending.set(elicitId, { toolCallId: id, mode, timer });
  send({ jsonrpc: "2.0", id: elicitId, method: "elicitation/create", params: elicitationParams(mode, nextElicitId) });
}

function handleRequest(message: JsonRecord): void {
  const { id, method } = message;
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const params = asRecord(message.params) ?? {};
  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: handleInitialize(params) });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: handleToolsList() });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/call":
      startElicitation(id, params);
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32_601, message: `method not found: ${String(method)}` } });
  }
}

function handleResponse(message: JsonRecord): void {
  const id = typeof message.id === "string" ? message.id : null;
  if (id === null) {
    return;
  }
  const entry = pending.get(id);
  if (entry === undefined) {
    return;
  }
  pending.delete(id);
  clearTimeout(entry.timer);
  const action = extractAction(message);
  send({
    jsonrpc: "2.0",
    id: entry.toolCallId,
    result: { content: [{ type: "text", text: `elicit:${entry.mode} action=${action}` }] },
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  const message = parseRecord(line);
  if (message === null) {
    return;
  }
  if (typeof message.method === "string") {
    handleRequest(message);
    return;
  }
  handleResponse(message);
});
lines.on("close", () => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
  }
  pending.clear();
  process.exit(0);
});
