/**
 * TOOLS LIST CHANGED (#399): does a running session's model see a change to
 * the tools an MCP server serves? `serveMcpTools` serves `alpha`, one turn
 * runs, `setTools` replaces it with `beta` (the server sends
 * `notifications/tools/list_changed` on every open GET stream), a second turn
 * runs. The scripted provider's raw requests say what the model was offered
 * in each turn: a runtime picks the change up when the second turn offers
 * `beta` and not `alpha`. The server's own log says whether the client opened
 * the stream and listed the tools again.
 *
 * Run: pnpm tsx experiments/mcp-tools-list-changed.ts [claude|codex|pi|opencode|kimi|grok|antigravity ...]
 * Token-free: every runtime talks to a local scripted provider (aimock).
 */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { serveMcpTools, type HostTool, type Runtime, type ServedMcpTools } from "../packages/oar/src/index.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv, type LLMock } from "../sea-trial/harness/aimock.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const ALPHA = "oar_probe_alpha";
const BETA = "oar_probe_beta";
const tool = (name: string): HostTool => ({
  name,
  description: `Probe tool ${name}, never called.`,
  inputSchema: { type: "object", properties: {} },
  handler: () => name,
});

const answer = (mock: LLMock): void => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); };
const starts: Readonly<Record<string, () => Promise<AimockEnv>>> = {
  claude: async () => startClaudeAimock(answer, { captureRaw: true }),
  codex: async () => startCodexAimock(answer, { captureRaw: true }),
  pi: async () => startPiAimock(answer, { captureRaw: true }),
  opencode: async () => startOpencodeAimock(answer),
  kimi: async () => startKimiAimock(answer),
  grok: async () => startGrokAimock(answer),
  antigravity: async () => startAntigravityAimock(answer),
};

/**
 * Which probe tools the last provider request of a turn defines in its
 * `tools` array, and which it only mentions elsewhere (history, system
 * reminders, deferred-tool lists).
 */
function offered(requests: AimockEnv["raw"]): { readonly defined: readonly string[]; readonly mentioned: readonly string[] } {
  const last = requests.at(-1)?.body;
  const record = typeof last === "object" && last !== null ? last as Record<string, unknown> : {};
  const tools = Array.isArray(record.tools) ? record.tools as unknown[] : [];
  // The whole definitions: codex nests MCP tools under a namespace entry.
  const names = JSON.stringify(tools);
  const rest = JSON.stringify({ ...record, tools: undefined });
  return {
    defined: [ALPHA, BETA].filter((name) => names.includes(name)),
    mentioned: [ALPHA, BETA].filter((name) => rest.includes(name)),
  };
}

/**
 * A logging pass-through in front of the served URL: what the runtime's MCP
 * client asked for (GET stream, each JSON-RPC method), forwarded unchanged.
 */
async function logged(served: ServedMcpTools, log: string[]): Promise<{ readonly url: string; close(): Promise<void> }> {
  const target = new URL(served.server.url);
  const proxy = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      if (incoming.method === "POST") {
        const text = body.toString("utf8");
        const methods = [...text.matchAll(/"method"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]);
        log.push(`POST ${methods.join(",")}`);
      } else {
        log.push(`${String(incoming.method)} accept=${String(incoming.headers.accept)}`);
      }
      const forward = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: incoming.method, headers: incoming.headers }, (answer) => {
        if (incoming.method !== "POST") { log.push(`  -> ${String(answer.statusCode)}`); }
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on("data", (chunk: Buffer) => {
          if (incoming.method === "GET" && chunk.toString("utf8").includes("list_changed")) { log.push("  stream <- list_changed"); }
          outgoing.write(chunk);
        });
        answer.on("end", () => { outgoing.end(); });
      });
      forward.on("error", () => { outgoing.destroy(); });
      outgoing.on("close", () => { forward.destroy(); });
      forward.end(body);
    });
  });
  await new Promise<void>((resolve) => { proxy.listen(0, "127.0.0.1", () => { resolve(); }); });
  const { port } = proxy.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    async close() {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => { proxy.close(() => { resolve(); }); });
    },
  };
}

async function turn(session: Awaited<ReturnType<Runtime["session"]>>, text: string): Promise<string> {
  const started = await session.prompt(text);
  const end = await awaitTurnEnd(session, started.request.seq);
  return end.kind;
}

async function probe(id: string): Promise<Record<string, unknown>> {
  const start = starts[id];
  if (start === undefined) {
    return { runtime: id, error: "no aimock backend" };
  }
  const log: string[] = [];
  const served = await serveMcpTools({ name: "probe", tools: [tool(ALPHA)] });
  const env = await start();
  const proxy = await logged(served, log);
  try {
    const runtime = allRuntimes.require(id);
    const installation = await runtime.installation?.();
    if (installation?.kind !== "available") {
      return { runtime: id, error: `not available: ${String(installation?.kind)}` };
    }
    const session = await runtime.session(installation, { cwd: process.cwd(), mcpServers: [{ ...served.server, url: proxy.url }], ...(env.env === undefined ? {} : { env: env.env }) });
    try {
      const first = await turn(session, "first turn: reply ok");
      const afterFirst = env.raw.length;
      served.setTools([tool(BETA)]);
      log.push("== setTools ==");
      // Room for a client that heard the notification to list the tools again.
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
      const second = await turn(session, "second turn: reply ok");
      const turnOne = offered(env.raw.slice(0, afterFirst));
      const turnTwo = offered(env.raw.slice(afterFirst));
      return {
        runtime: id,
        turns: [first, second],
        requests: [afterFirst, env.raw.length - afterFirst],
        turnOne,
        turnTwo,
        pickedUp: turnOne.defined.includes(ALPHA) && turnTwo.defined.includes(BETA) && !turnTwo.defined.includes(ALPHA),
        server: log,
      };
    } finally {
      await session.dispose();
    }
  } catch (error) {
    return { runtime: id, error: error instanceof Error ? error.message : String(error), log };
  } finally {
    await env.stop();
    await proxy.close();
    await served.close();
  }
}

const ids = process.argv.slice(2);
for (const id of ids.length > 0 ? ids : ["claude", "codex", "pi", "opencode", "kimi", "grok"]) {
  // oxlint-disable-next-line no-await-in-loop -- one runtime at a time keeps the provider log attributable.
  console.log(JSON.stringify(await probe(id)));
}
