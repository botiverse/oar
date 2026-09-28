import http from "node:http";

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

/**
 * A pass-through proxy in front of aimock that keeps each request body as
 * sent. aimock's own journal normalizes a request to its chat shape and drops
 * the fields the vendor tests need to see (claude's `output_config.effort`,
 * codex's `reasoning.effort`, pi's `thinking`), so a vendor test that asserts
 * what reached the provider opts into this. Responses stream back untouched.
 */
export async function startRawCapture(target: string): Promise<RawCapture> {
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
      const forward = http.request({
        hostname: upstream.hostname,
        port: upstream.port,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: upstream.host },
      }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      });
      forward.on("error", () => {
        response.destroy();
      });
      forward.end(raw);
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
