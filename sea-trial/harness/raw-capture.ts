import http from "node:http";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/** One provider request exactly as the runtime sent it: the parsed JSON body (or null when it was not JSON). */
export interface RawProviderRequest {
  readonly path: string;
  readonly body: unknown;
}

export interface RawCapture {
  /** Point the runtime here instead of at aimock. */
  readonly url: string;
  /** Every request in arrival order. */
  readonly requests: readonly RawProviderRequest[];
  stop(): Promise<void>;
}

/** Rewrites a whole response body on its way back to the runtime. */
export type ResponseRewrite = (body: string) => string;

/** Rewrites a parsed request body on its way to aimock; the capture keeps it as the runtime sent it. */
export type RequestRewrite = (body: unknown) => unknown;

/**
 * A pass-through proxy in front of aimock that keeps each request body as
 * sent. aimock's own journal normalizes a request to its chat shape and drops
 * the fields the vendor tests need to see (claude's `output_config.effort`,
 * codex's `reasoning.effort`, pi's `thinking`), so a vendor test that asserts
 * what reached the provider opts into this. Responses stream back untouched,
 * unless `rewrite` is given: then each response is read whole, rewritten and
 * sent at once (for a reply shape aimock cannot script, `namespaceMcpToolCalls`).
 * `forward` rewrites a JSON request aimock would misread before it is passed
 * on (`geminiToolResultsAsUser`).
 */
export async function startRawCapture(target: string, rewrite?: ResponseRewrite, forward?: RequestRewrite): Promise<RawCapture> {
  const upstream = new URL(target);
  const requests: RawProviderRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body: unknown = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        // Not JSON: recorded as null, still forwarded.
      }
      requests.push({ path: request.url ?? "", body });
      const rewritten = forward === undefined || body === null ? null : Buffer.from(JSON.stringify(forward(body)));
      const { "content-length": _sentLength, "transfer-encoding": _sentEncoding, ...rest } = request.headers;
      const proxied = http.request({
        hostname: upstream.hostname,
        port: upstream.port,
        path: request.url,
        method: request.method,
        headers: rewritten === null ? { ...request.headers, host: upstream.host } : { ...rest, "content-length": String(rewritten.length), host: upstream.host },
      }, (reply) => {
        if (rewrite === undefined) {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
          return;
        }
        const parts: Buffer[] = [];
        reply.on("data", (chunk: Buffer) => {
          parts.push(chunk);
        });
        reply.on("end", () => {
          const { "content-length": _length, ...headers } = reply.headers;
          response.writeHead(reply.statusCode ?? 502, headers);
          response.end(rewrite(Buffer.concat(parts).toString("utf8")));
        });
      });
      proxied.on("error", () => {
        response.destroy();
      });
      proxied.end(rewritten ?? raw);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** A Responses `function_call` item named `mcp__<server>__<tool>`, rewritten into codex's namespaced form; any other value as it was. */
function namespacedCall(value: unknown): unknown {
  const item = asRecord(value);
  const named = item?.type === "function_call" && typeof item.name === "string" ? /^(mcp__.+)__([^_].*)$/u.exec(item.name) : null;
  return named === null ? value : { ...item, namespace: named[1], name: named[2] };
}

/**
 * codex 0.160.1 offers an MCP server's tools to the model as one `namespace`
 * tool (`mcp__<server>`, its tools inside) and runs a call only when the
 * model's `function_call` names that namespace beside the bare tool name; a
 * flat `mcp__echo__echo` call is answered "unsupported call". aimock scripts
 * only flat names, so this rewrites each streamed event's function_call items
 * (`item`, and `response.output`) named `mcp__<server>__<tool>` into
 * `{ namespace: "mcp__<server>", name: "<tool>" }`.
 */
export function namespaceMcpToolCalls(body: string): string {
  return body.split("\n").map((line) => {
    const event = line.startsWith("data: ") ? asRecord(parseJson(line.slice("data: ".length))) : null;
    if (event === null) {
      return line;
    }
    const response = asRecord(event.response);
    const output = Array.isArray(response?.output) ? { response: { ...response, output: response.output.map(namespacedCall) } } : {};
    return `data: ${JSON.stringify({ ...event, ...("item" in event ? { item: namespacedCall(event.item) } : {}), ...output })}`;
  }).join("\n");
}

/**
 * Antigravity's harness (agy_acp_server 1.3.0) sends a Gemini request's
 * `functionResponse` parts under role `model`; aimock reads a tool result
 * only under role `user`, so this hands aimock those contents as `user`.
 */
export function geminiToolResultsAsUser(body: unknown): unknown {
  const request = asRecord(body);
  if (request === null || !Array.isArray(request.contents)) {
    return body;
  }
  const contents: unknown[] = [];
  for (const value of request.contents) {
    const content = asRecord(value);
    const parts: unknown[] = Array.isArray(content?.parts) ? content.parts : [];
    const toolResults = content?.role === "model" && parts.length > 0 && parts.every((part) => asRecord(part)?.functionResponse !== undefined);
    contents.push(toolResults ? { ...content, role: "user" } : value);
  }
  return { ...request, contents };
}
