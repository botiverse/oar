/* A minimal OpenAI-compatible provider for experiments/hermes-acp/mcp-credentials-probe.ts: it asks for one MCP tool call, then answers. */
import { once } from "node:events";
import { createServer } from "node:http";

export interface ToolCallingProvider {
  /** Base URL, as `config.yaml`'s `model.base_url` wants it. */
  readonly url: string;
  /** The tool names the agent offered, in offer order, one array per request. */
  offeredToolNames(): readonly (readonly string[])[];
  close(): Promise<void>;
}

interface ChatBody {
  readonly stream?: unknown;
  readonly tools?: readonly { readonly function?: { readonly name?: unknown } }[];
  readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
}

function toolNames(body: ChatBody): readonly string[] {
  return (body.tools ?? []).map((tool) => (typeof tool.function?.name === "string" ? tool.function.name : "")).filter((name) => name.length > 0);
}

/** The tool to call: the MCP probe's echo tool, whatever the gateway prefixes it with. */
function probeTool(names: readonly string[]): string | undefined {
  return names.find((name) => name.includes("probe_echo"));
}

function chunk(model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-oar", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

/**
 * Streams `delta`s for one answer. The first request of a turn that offers a
 * tool answers a `tool_calls` block naming the probe's tool; a request that
 * already carries a tool result answers text. No account, no real model.
 */
export async function startToolCallingProvider(reply = "the probe tool answered"): Promise<ToolCallingProvider> {
  const offered: (readonly string[])[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.includes("/models") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "oar-fake-model", object: "model", owned_by: "oar" }] }));
      return;
    }
    if (request.method !== "POST" || request.url?.includes("/chat/completions") !== true) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    let raw = "";
    request.on("data", (part: Buffer | string) => { raw += String(part); });
    request.on("end", () => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- JSON.parse answers `any`; the request body is narrowed to the fields this provider reads.
      const body: ChatBody = JSON.parse(raw);
      const names = toolNames(body);
      offered.push(names);
      // A fresh turn ends with the user's message; after the tool's result the
      // last message is the tool's, and the model answers in text.
      const messages = body.messages ?? [];
      const fresh = messages.at(-1)?.role === "user";
      // The probe's second prompt names the echo; the tool then answers with the
      // value it was started under, which is what reaches OAR's records.
      const echoRequested = messages.some((message) => JSON.stringify(message.content ?? "").includes("echo the value"));
      const tool = fresh ? probeTool(names) : undefined;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (tool === undefined) {
        response.write(chunk("oar-fake-model", { role: "assistant", content: reply }, null));
        response.write(chunk("oar-fake-model", {}, "stop"));
      } else {
        const args = JSON.stringify({ text: "hello", ...(echoRequested ? { echoToken: true } : {}) });
        response.write(chunk("oar-fake-model", { role: "assistant", tool_calls: [{ index: 0, id: "call_oar_probe", type: "function", function: { name: tool, arguments: args } }] }, null));
        response.write(chunk("oar-fake-model", {}, "tool_calls"));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") { throw new Error("the scripted provider has no port"); }
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    offeredToolNames: () => offered,
    close: async () => { server.close(); await once(server, "close"); },
  };
}
