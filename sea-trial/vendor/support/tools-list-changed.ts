/* oxlint-disable promise/avoid-new -- Native HTTP pass-through with a callback-based server lifecycle. */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpToolsListChanged } from "../../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../../packages/oar/src/observe/turns.js";
import { serveMcpTools, type HostTool, type ServedMcpTools } from "../../../packages/oar/src/index.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";
import type { AimockEnv } from "../../harness/aimock.js";

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
  try {
    const session = await open({ name: SERVER, type: "http", url: proxy.url });
    try {
      // A client may list the tools after the session opens (opencode 2.x) or
      // only at the first prompt (antigravity): the first turn waits a while,
      // then runs anyway.
      await poll(() => log.includes("tools/list"), 10_000);
      await turn(session, "first turn: reply ok");
      const afterFirst = env.raw.length;
      const connected = log.includes("tools/list");
      served.setTools([tool(BETA)]);
      log.push("setTools");
      const relistedNow = (): boolean => log.slice(log.indexOf("setTools")).includes("tools/list");
      // A client that heard the notification lists again before the second turn is built.
      await poll(relistedNow, 10_000);
      await turn(session, "second turn: reply ok");
      return { turns: [env.raw.slice(0, afterFirst), env.raw.slice(afterFirst)], log: [...log], connected, relisted: relistedNow() };
    } finally {
      await session.dispose();
    }
  } finally {
    await proxy.close();
    await served.close();
  }
}

/**
 * What the model saw, where the requests define MCP tools in `tools`: the
 * declaration the second turn supports, or null when they define none to
 * judge by (grok reaches MCP tools through `use_tool`; opencode 2.x and
 * antigravity list them in a system update or the system instruction).
 */
export function modelView(run: ToolsListChangedRun): McpToolsListChanged | null {
  const first = defined(lastWithTools(run.turns[0]));
  const second = defined(lastWithTools(run.turns[1]));
  if (!first.includes(ALPHA)) {
    return null;
  }
  if (!second.includes(BETA)) {
    return "none";
  }
  return second.includes(ALPHA) ? "additions" : "full";
}
