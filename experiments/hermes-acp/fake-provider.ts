/* A minimal OpenAI-compatible provider for experiments/hermes-acp/probe.ts: one model and one streamed reply. */
import { once } from "node:events";
import { createServer } from "node:http";

export interface FakeProvider {
  readonly url: string;
  close(): Promise<void>;
}

export async function startFakeProvider(reply = "hello from the OAR fake provider"): Promise<FakeProvider> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.includes("/models") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "oar-fake-model", object: "model", owned_by: "oar" }] }));
      return;
    }
    if (request.method === "POST" && request.url?.includes("/chat/completions") === true) {
      let body = "";
      request.on("data", (chunk: Buffer | string) => { body += String(chunk); });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        const stream = typeof parsed === "object" && parsed !== null && "stream" in parsed && parsed.stream === true;
        if (stream) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const chunk = {
            id: "chatcmpl-oar", object: "chat.completion.chunk", created: 0, model: "oar-fake-model",
            choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
          };
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-oar", object: "chat.completion", created: 0, model: "oar-fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
      });
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") { throw new Error("fake provider has no port"); }
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    close: async () => { server.close(); await once(server, "close"); },
  };
}
