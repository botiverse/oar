import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../../packages/oar/src/shared/json.js";

export interface ProviderRequest {
  readonly messages: readonly JsonRecord[];
  readonly body: JsonRecord;
}

/** One provider reply, as DSH's OpenAI-compatible route reads it. */
export type Reply =
  | { readonly kind: "say"; readonly text: string; readonly reasoning?: string }
  | { readonly kind: "tool"; readonly name: string; readonly arguments: JsonRecord; readonly id?: string }
  | { readonly kind: "hold"; readonly text: string }
  | { readonly kind: "error"; readonly status: number; readonly body: JsonRecord }
  | { readonly kind: "length"; readonly text: string };

export interface DshProvider {
  readonly url: string;
  readonly requests: readonly ProviderRequest[];
  /** Finish the oldest held stream as a completed reply. */
  release(this: void): void;
  /** Resolves once a held stream has started. */
  held(this: void): Promise<void>;
  sent(this: void, text: string): boolean;
  stop(this: void): Promise<void>;
}

/** The latest input a person gave, past DSH's own runtime-context message. */
export function lastInput(request: ProviderRequest): string {
  const users = request.messages.filter((message) => message.role === "user" && !JSON.stringify(message.content).includes("Current runtime context"));
  return JSON.stringify(users.at(-1)?.content ?? "");
}

export function toolResults(request: ProviderRequest): number {
  return request.messages.filter((message) => message.role === "tool").length;
}

function chunk(res: ServerResponse, delta: JsonRecord, finish: string | null, usage?: JsonRecord): void {
  res.write(`data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 1, model: "aimock-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`);
}

const USAGE = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, prompt_tokens_details: { cached_tokens: 40 } };

/** A loopback model endpoint a test scripts per request, for what aimock has no shape for: a held stream, a provider error sequence, a native tool call. */
export async function startDshProvider(script: (request: ProviderRequest) => Reply): Promise<DshProvider> {
  const requests: ProviderRequest[] = [];
  const open: ServerResponse[] = [];
  const waiters: (() => void)[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => { parts.push(part); });
    req.on("end", () => {
      const body = asRecord(parseJson(Buffer.concat(parts).toString("utf8"))) ?? {};
      const request = { body, messages: asRecordList(body.messages) };
      requests.push(request);
      const reply = script(request);
      if (reply.kind === "error") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: reply.body }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (reply.kind === "tool") {
        const encoded = JSON.stringify(reply.arguments);
        const split = Math.floor(encoded.length / 2);
        const id = reply.id ?? `call-${String(requests.length)}`;
        chunk(res, { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: reply.name, arguments: encoded.slice(0, split) } }] }, null);
        chunk(res, { tool_calls: [{ index: 0, function: { arguments: encoded.slice(split) } }] }, null);
        chunk(res, {}, "tool_calls", USAGE);
      } else if (reply.kind === "hold") {
        chunk(res, { role: "assistant", content: reply.text }, null);
        open.push(res);
        for (const waiter of waiters.splice(0)) { waiter(); }
        return;
      } else {
        if (reply.kind === "say" && reply.reasoning !== undefined) { chunk(res, { role: "assistant", reasoning_content: reply.reasoning }, null); }
        chunk(res, { role: "assistant", content: reply.text.slice(0, 3) }, null);
        chunk(res, { content: reply.text.slice(3) }, null);
        chunk(res, {}, reply.kind === "length" ? "length" : "stop", USAGE);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${String((address satisfies AddressInfo).port)}`,
    requests,
    release: () => {
      const res = open.shift();
      assert.ok(res !== undefined, "no stream is held");
      chunk(res, {}, "stop", USAGE);
      res.end("data: [DONE]\n\n");
    },
    held: async () => {
      if (open.length > 0) { return; }
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push(resolve);
      await promise;
    },
    sent: (text) => requests.some((request) => JSON.stringify(request.messages).includes(text)),
    stop: async () => {
      for (const res of open.splice(0)) { res.destroy(); }
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

/** The native durable log of one session, read from DSH_HOME without DSH: every event as its persistence wrote it. */
export async function durableEvents(dshHome: string, sessionId: string): Promise<readonly JsonRecord[]> {
  const root = path.join(dshHome, "sessions");
  const keys = await readdir(root);
  const candidates = await Promise.all(keys.map(async (key) => {
    const entries = await readdir(path.join(root, key)).catch((): string[] => []);
    return entries.includes(sessionId) ? path.join(root, key, sessionId) : null;
  }));
  const found = candidates.find((directory) => directory !== null);
  assert.ok(typeof found === "string", `no durable directory for ${sessionId}`);
  const names = await readdir(found);
  const log = names.find((name) => name.endsWith(".jsonl.zstd"));
  assert.ok(log !== undefined, `no durable log in ${names.join(", ")}`);
  const text = zstdDecompressSync(await readFile(path.join(found, log))).toString("utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => asRecord(parseJson(line)) ?? {}).filter((entry) => typeof entry.type === "string" && "seq" in entry);
}
