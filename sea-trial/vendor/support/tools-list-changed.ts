/* oxlint-disable promise/avoid-new -- Native HTTP pass-through with a callback-based server lifecycle. */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { awaitTurnEnd } from "../../../packages/oar/src/observe/turns.js";
import { serveMcpTools, type HostTool, type ServedMcpTools, type Session, type McpToolsListChanged } from "../../../packages/oar/src/index.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";
import type { AimockEnv, LLMock } from "../../harness/aimock.js";
import { claudeMcpCatalog } from "./claude-tools.js";
import { currentTurnSays } from "./echo-mcp.js";
import { record } from "../../harness/trace.js";

/*
 * Does a running session take a change to an attached MCP server's tools
 * (#399)? `serveMcpTools` serves ALPHA, one turn runs, `setTools` replaces it
 * with BETA (the server sends `notifications/tools/list_changed` on every
 * open GET stream), a second turn runs. A logging pass-through in front of
 * the served URL shows whether the client listed the tools again; the
 * scripted provider's raw requests show what the model was offered.
 */

export const ALPHA = "oar_probe_alpha";
export const BETA = "oar_probe_beta";
export const SERVER = "probe";

const tool = (name: string): HostTool => ({
  name,
  description: `Probe tool ${name}, never called.`,
  inputSchema: { type: "object", properties: {} },
  handler: () => name,
});

/** Which probe tools a provider request defines in its `tools` array (codex nests MCP tools under a namespace entry). */
export function defined(body: unknown): readonly string[] {
  const tools = JSON.stringify(asRecord(body)?.tools ?? []);
  return [ALPHA, BETA].filter((name) => tools.includes(name));
}

/** Direct definitions or Claude's currently searchable deferred names, never mere mentions in history. */
export function offered(body: unknown): readonly string[] {
  const searchable = claudeMcpCatalog(body).searchable;
  const schemas = defined(body);
  return [ALPHA, BETA].filter((name) => schemas.includes(name) || searchable.includes(`mcp__${SERVER}__${name}`));
}

/**
 * Load each Claude probe tool before finishing its turn. A removed tool's
 * already loaded schema stays offered, even when ToolSearch withdraws it.
 * This exercises the declaration's limit instead of only never-loaded tools.
 * Leave the native tool-search setting alone; direct catalogs need no search.
 */
export function loadClaudeProbeTools(mock: LLMock): void {
  for (const [label, name] of [["first", ALPHA], ["second", BETA]] as const) {
    mock.on({
      predicate: (request) => currentTurnSays(new RegExp(`${label} turn`, "u"))(request)
        && (request.tools ?? []).some((entry) => entry.function.name === "ToolSearch"),
      hasToolResult: false,
    }, { toolCalls: [{ id: `search_${label}`, name: "ToolSearch", arguments: JSON.stringify({ query: `select:mcp__${SERVER}__${name}`, max_results: 5 }) }] });
    mock.on({ hasToolResult: true, toolCallId: `search_${label}` }, { content: "ok" });
  }
  mock.on({ predicate: (request) => !(request.tools ?? []).some((entry) => entry.function.name === "ToolSearch") }, { content: "ok" });
}

/** The last request of a turn that defines any tools: side requests (opencode's title) carry none. */
export function lastWithTools(requests: AimockEnv["raw"]): unknown {
  return requests.findLast((request) => {
    const tools = asRecord(request.body)?.tools;
    return Array.isArray(tools) && tools.length > 0;
  })?.body;
}

export interface ToolsListChangedRun {
  /** Provider requests of each turn, in arrival order. */
  readonly turns: readonly [AimockEnv["raw"], AimockEnv["raw"]];
  /** What the runtime's MCP client sent: "GET stream", each JSON-RPC method, and "setTools" where the change happened. */
  readonly log: readonly string[];
  /** Whether the client listed the tools before the change: without it, "never listed again" proves nothing. */
  readonly connected: boolean;
  /** Whether the client listed the tools again after the change. */
  readonly relisted: boolean;
}

/**
 * A pass-through that logs what the client asks for and adds the served
 * bearer token, so the session's entry carries no `headers` (antigravity
 * refuses entries with credentials).
 */
export async function loggingProxy(served: ServedMcpTools, log: string[]): Promise<{ readonly url: string; close(): Promise<void> }> {
  const target = new URL(served.server.url);
  const proxy = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      if (incoming.method === "POST") {
        const methods = [...body.toString("utf8").matchAll(/"method"\s*:\s*"(?<method>[^"]+)"/gu)].map((match) => match.groups?.method ?? "");
        log.push(...methods);
      } else {
        log.push(`${String(incoming.method)} stream`);
      }
      const forward = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: incoming.method, headers: { ...incoming.headers, authorization: served.server.headers?.Authorization ?? "" } }, (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      });
      forward.on("error", () => { outgoing.destroy(); });
      outgoing.on("close", () => { forward.destroy(); });
      forward.end(body);
    });
  });
  await new Promise<void>((resolve) => { proxy.listen(0, "127.0.0.1", () => { resolve(); }); });
  const address: string | AddressInfo | null = proxy.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    async close() {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => { proxy.close(() => { resolve(); }); });
    },
  };
}

async function turn(session: Session, text: string): Promise<void> {
  const started = await session.prompt(text);
  await awaitTurnEnd(session, started.request.seq);
}

/** Wait until `done()` or `ms` passed, checking every 100 ms. */
async function poll(done: () => boolean, ms: number): Promise<void> {
  for (let waited = 0; !done() && waited < ms; waited += 100) {
    // oxlint-disable-next-line no-await-in-loop -- polls the log.
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** Run the two turns around a `setTools` on a session `open` starts with the probe server attached. */
export async function runToolsListChanged(env: AimockEnv, open: (server: { readonly name: string; readonly type: "http"; readonly url: string }) => Promise<Session>): Promise<ToolsListChangedRun> {
  const log: string[] = [];
  const served = await serveMcpTools({ name: SERVER, tools: [tool(ALPHA)] });
  const proxy = await loggingProxy(served, log);
  let phase = "opening";
  const progress = process.env.OAR_TEST_MCP_PROGRESS === "1" ? setInterval(() => {
    record({ kind: "mcp_catalog_progress", phase, methods: [...log], providerRequests: env.raw.length });
  }, 10_000).unref() : undefined;
  try {
    const session = await open({ name: SERVER, type: "http", url: proxy.url });
    try {
      // A client may list the tools after the session opens (opencode 2.x) or
      // only at the first prompt (antigravity): the first turn waits a while,
      // then runs anyway.
      phase = "initial_catalog";
      await poll(() => log.includes("tools/list"), 10_000);
      phase = "first_turn";
      await turn(session, "first turn: reply ok");
      const afterFirst = env.raw.length;
      const connected = log.includes("tools/list");
      served.setTools([tool(BETA)]);
      log.push("setTools");
      phase = "changed_catalog";
      const relistedNow = (): boolean => log.slice(log.indexOf("setTools")).includes("tools/list");
      // A client that heard the notification lists again before the second turn is built.
      await poll(relistedNow, 10_000);
      phase = "second_turn";
      await turn(session, "second turn: reply ok");
      return { turns: [env.raw.slice(0, afterFirst), env.raw.slice(afterFirst)], log: [...log], connected, relisted: relistedNow() };
    } finally {
      phase = "dispose";
      await session.dispose();
    }
  } finally {
    if (progress !== undefined) { clearInterval(progress); }
    await proxy.close();
    await served.close();
  }
}

/**
 * What the model saw, where requests define MCP tools or offer ToolSearch: the
 * declaration the second turn supports, or null when they define none to
 * judge by (grok reaches MCP tools through `use_tool`; opencode 2.x and
 * antigravity list them in a system update or the system instruction).
 */
export function modelView(run: ToolsListChangedRun): McpToolsListChanged | null {
  const first = offered(lastWithTools(run.turns[0]));
  const second = offered(lastWithTools(run.turns[1]));
  if (!first.includes(ALPHA)) {
    return null;
  }
  if (!second.includes(BETA)) {
    return "none";
  }
  return second.includes(ALPHA) ? "additions" : "full";
}
