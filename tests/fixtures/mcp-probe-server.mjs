/* oxlint-disable import/no-nodejs-modules, eslint/no-underscore-dangle, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call, unicorn/prefer-top-level-await -- Standalone MCP stdio server used as a session MCP entry by the Hermes fixtures. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

/*
 * A session MCP server a runtime starts as a stdio entry, in the shape
 * `session_local_mcp._configs` builds: JSON-RPC over stdin/stdout, one eager
 * `tools/list` at attach. It carries NO real credential of any kind: the only
 * secret in play is the synthetic `MCP_PROBE_TOKEN` an `mcpServers` entry's
 * `env` supplies, and the fixture reports what it actually received so a test
 * can prove which generation of values reached the tool process.
 *
 * Every observation appends one JSON line to `MCP_PROBE_LOG`:
 *   {"event":"start","token":"<what env gave me>"}
 *   {"event":"initialize","token":…}
 *   {"event":"tools/list","token":…,"tools":["probe_echo"]}
 *   {"event":"tools/call","token":…,"argument":"hello"}
 */

const logPath = process.env.MCP_PROBE_LOG;
const token = process.env.MCP_PROBE_TOKEN ?? null;

function log(entry) {
  if (typeof logPath === "string") {
    appendFileSync(logPath, `${JSON.stringify({ token, ...entry })}\n`);
  }
}
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function result(id, value = {}) {
  send({ jsonrpc: "2.0", id, result: value });
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOL = {
  name: "probe_echo",
  description: "Echo text back to the caller, together with what this process's MCP_PROBE_TOKEN holds.",
  inputSchema: { type: "object", properties: { text: { type: "string" }, echoToken: { type: "boolean" } }, required: [] },
};

function callTool(id, params) {
  const name = params?.name;
  const argument = params?.arguments?.text ?? "";
  const echoToken = params?.arguments?.echoToken === true;
  log({ event: "tools/call", name, argument, echoToken });
  if (name !== TOOL.name) {
    error(id, -32_602, `unknown tool: ${String(name)}`);
    return;
  }
  // Asked for with `echoToken`, the value travels back in the tool result, so a
  // test can see whether the runtime's own reporting of that result reaches
  // OAR's records unredacted (and into the runtime's transcript store).
  const text = echoToken ? `probe:${String(token)}:${String(argument)}` : `probe:${String(argument)}`;
  result(id, { content: [{ type: "text", text }], isError: false });
}

const handlers = {
  initialize(id, params) {
    log({ event: "initialize" });
    result(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "oar-mcp-probe", version: "1.0.0" },
    });
  },
  "notifications/initialized"() {
    // A notification: nothing to answer.
  },
  ping(id) {
    result(id, {});
  },
  "tools/list"(id) {
    log({ event: "tools/list", tools: [TOOL.name] });
    result(id, { tools: [TOOL] });
  },
  "tools/call": callTool,
};

function handle(message) {
  const { id, method, params } = message;
  // The fixture sends no requests, so a message without a method is not ours to answer.
  const handler = method === undefined ? undefined : handlers[method];
  if (handler === undefined) {
    if (method !== undefined) {
      error(id, -32_601, `unknown method: ${String(method)}`);
    }
    return;
  }
  handler(id, params);
}

log({ event: "start" });
const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
reader.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }
  handle(JSON.parse(line));
});
