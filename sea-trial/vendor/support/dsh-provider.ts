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

/**
 * The latest user message that is not DSH's own context. A first request carries the
 * input, then a runtime-context snapshot and, where DSH has bundled skills to offer
 * (Windows, in `skill-catalog`), a system reminder.
 */
export function lastInput(request: ProviderRequest): string {
  const users = request.messages.filter((message) => message.role === "user" && !/Current runtime context|<system-reminder>/u.test(JSON.stringify(message.content)));
  return JSON.stringify(users.at(-1)?.content ?? "");
}

/** Every Zstandard frame of a log, in order. DSH appends a frame per write, and Node's one-shot decoder reads only the first on some 24.x releases. */
export function zstdFrames(data: Buffer): readonly Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const start = offset;
    const magic = data.readUInt32LE(offset);
    offset += 4;
    if ((magic & 0xFF_FF_FF_F0) >>> 0 === 0x18_4D_2A_50) {
      offset += 4 + data.readUInt32LE(offset);
    } else {
      assert.equal(magic, 0xFD_2F_B5_28, `not a Zstandard frame at byte ${String(start)}`);
      const descriptor = data.readUInt8(offset);
      offset += 1;
      const contentFlag = descriptor >> 6;
      const singleSegment = (descriptor & 0x20) !== 0;
      const contentSize = [singleSegment ? 1 : 0, 2, 4, 8][contentFlag] ?? 0;
      offset += (singleSegment ? 0 : 1) + ([0, 1, 2, 4][descriptor & 3] ?? 0) + contentSize;
      for (;;) {
        const header = data.readUIntLE(offset, 3);
        offset += 3;
        const type = (header >> 1) & 3;
        assert.notEqual(type, 3, `reserved Zstandard block at byte ${String(offset)}`);
        offset += type === 1 ? 1 : header >> 3;
        if ((header & 1) === 1) { break; }
      }
      if ((descriptor & 4) !== 0) { offset += 4; }
      assert.ok(offset <= data.length, `truncated Zstandard frame at byte ${String(start)}`);
      frames.push(data.subarray(start, offset));
    }
  }
  return frames;
}

export function decompressZstd(data: Buffer): string {
  return zstdFrames(data).map((frame) => zstdDecompressSync(frame).toString("utf8")).join("");
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
      // A script that never holds fails here and disposes its sessions, not at the test's own limit.
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        const last = requests.at(-1);
        reject(new Error(`no stream was held within 20 s; last input ${last === undefined ? "none" : lastInput(last)}`));
      }, 20_000);
      waiters.push(resolve);
      try { await promise; } finally { clearTimeout(timer); }
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
  const text = decompressZstd(await readFile(path.join(found, log)));
  return text.split("\n").filter((line) => line.length > 0).map((line) => asRecord(parseJson(line)) ?? {}).filter((entry) => typeof entry.type === "string" && "seq" in entry);
}
