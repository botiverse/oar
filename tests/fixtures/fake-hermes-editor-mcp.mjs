/* oxlint-disable import/no-nodejs-modules, eslint/no-underscore-dangle, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/return-await -- Standalone fixture modeling the Hermes gateway's editor MCP owner. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

/*
 * `gateway/session_local_mcp.py` of `hermes 0.23.3`, as a fixture: the owner
 * of a session's editor MCP servers, not the ACP viewer.
 *
 * - A stdio entry is spawned with its own `env` applied, and discovery is one
 *   eager `tools/list` (`_configs` + `register_mcp_servers`, `lazy=False`).
 * - The values themselves live only in this process's memory
 *   (`authority._local_editor_mcp`, "borrowed" per session scope). What reaches
 *   the store is `editor_mcp_json`: scope, the list's fingerprint, the frozen
 *   schemas and the derived server names — never an env or header value.
 * - A list whose fingerprint changed re-spawns the servers; the same list on a
 *   later attach keeps the running connections, and an empty or omitted list
 *   keeps the session's servers (`resume_editor_mcp`).
 *
 * What this fixture does NOT model: the `editor_mcp` mutation fences, schema
 * drift re-freezing, the borrowed holders surviving a viewer restart (the real
 * owner is a daemon; a fixture holder dies with the ACP process) and the
 * `launch_credentials_unavailable` state a restarted owner reaches.
 * `experiments/hermes-acp/mcp-credentials-probe.ts` runs the real daemon for
 * those.
 */

const PROTOCOL_VERSION = "2025-06-18";

/** The list's fingerprint, as `session_local_mcp.fingerprint` computes it. */
export function editorMcpFingerprint(servers) {
  return createHash("sha256").update(JSON.stringify(servers)).digest("hex");
}

/** Where the daemon's store would keep `editor_mcp_json`; never an env or header value. */
export function editorPolicyPath(home) {
  return path.join(home, "editor-mcp-policy.json");
}

/** The ACP `env`/`headers` pairs as the map the daemon passes to its MCP client. */
function pairs(entry) {
  return Array.isArray(entry)
    ? Object.fromEntries(entry.filter((item) => typeof item?.name === "string").map((item) => [item.name, String(item.value ?? "")]))
    : {};
}

/** One stdio MCP connection: JSON-RPC requests over the child's pipes. */
function connectStdio(spec) {
  const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
    // The entry's own env, on top of this process's: what the daemon's
    // `_configs` builds for `register_mcp_servers`.
    env: { ...process.env, ...pairs(spec.env) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message = null;
    try { message = JSON.parse(line); } catch { return; }
    const settle = waiting.get(message?.id);
    if (settle !== undefined) {
      waiting.delete(message.id);
      settle(message);
    }
  });
  return {
    name: String(spec.name),
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const answered = Promise.withResolvers();
      waiting.set(id, answered.resolve);
      if (child.stdin.writable) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      return answered.promise;
    },
    notify(method, params) {
      if (child.stdin.writable) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
    },
    stop() {
      for (const settle of waiting.values()) { settle({ error: { code: -32_000, message: "editor server stopped" } }); }
      waiting.clear();
      child.kill();
    },
  };
}

/** One server connection after discovery: the tools its eager `tools/list` answered. */
async function discover(spec, log) {
  const server = connectStdio(spec);
  const initialized = await server.request("initialize", {
    protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "hermes-gateway", version: "0.23.3" },
  });
  if (initialized.error !== undefined) { throw new Error(`editor MCP ${server.name} refused initialize`); }
  server.notify("notifications/initialized", {});
  const listed = await server.request("tools/list", {});
  const tools = Array.isArray(listed.result?.tools) ? listed.result.tools.map((tool) => String(tool.name)) : [];
  log(`editor_mcp:discover:${server.name}:${String(tools.length)}`);
  return Object.assign(server, { tools });
}

/** The frozen `editor_mcp_json` the store keeps: no env or header value, only a fingerprint and names. */
function writeEditorPolicy(holder, home, fingerprint) {
  const schemas = {};
  for (const connection of holder.connections) {
    for (const tool of connection.tools) {
      schemas[`mcp__editor_${connection.name}__${tool}`] = { name: tool };
    }
  }
  const names = holder.connections.map((connection, index) => [String(index), connection.name]);
  const scope = `editor-session:fixture-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
  mkdirSync(home, { recursive: true });
  writeFileSync(editorPolicyPath(home), JSON.stringify({ scope, fingerprint, schemas, names: Object.fromEntries(names) }, null, 2));
}

/**
 * The daemon's `bind_editor_mcp`/`resume_editor_mcp` for one session: the
 * returned holder is the session's borrowed credentials, in memory only.
 */
export async function attachEditorServers({ servers, home, log }) {
  const holder = { fingerprint: null, connections: [], tools: new Set() };
  if (!Array.isArray(servers) || servers.length === 0) {
    return holder; // an empty or omitted list keeps the session's servers
  }
  const stdio = servers.filter((server) => (server.type ?? "stdio") === "stdio");
  holder.fingerprint = editorMcpFingerprint(servers);
  holder.connections = await Promise.all(stdio.map(async (spec) => await discover(spec, log)));
  writeEditorPolicy(holder, home, holder.fingerprint);
  log(`editor_mcp:attach:${holder.connections.map((connection) => connection.name).join(",")}:${holder.fingerprint.slice(0, 12)}`);
  return holder;
}

/** Stop a holder's connections: the last borrower left, or a changed list replaced them. */
export function closeEditorServers(holder) {
  for (const connection of holder.connections) { connection.stop(); }
  holder.connections = [];
  holder.fingerprint = null;
}

/** One `tools/call` on the first held server, with the text it answered. */
export async function callEditorTool({ holder, tool, args, log }) {
  const [connection] = holder.connections;
  if (connection === undefined) { return "no editor MCP server is attached"; }
  log(`editor_mcp:call:${connection.name}:${tool}`);
  const answered = await connection.request("tools/call", { name: tool, arguments: args });
  const content = answered.result?.content;
  return Array.isArray(content) ? content.map((block) => String(block?.text ?? "")).join("") : "";
}
