/**
 * Codex's real app-server against a held local Responses stream; no login or model calls.
 * Run: OAR_CODEX_BIN=/path/to/codex pnpm tsx experiments/codex-instant-interrupt.ts [output-dir]
 * OBSERVED 2026-09-29, Codex 0.159.0, Linux: enabled steer preempts sampling or
 * yields a code-mode cell in the same turn. Queue/abort remain distinct. Direct
 * tools finish normally. Partial assistant text remains visible but is absent
 * from replacement context. See codex-instant-interrupt.md for scope and evidence.
 * The tool cases require python3 on PATH and only sleep/print inside a temp cwd.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRuntimes, type ControlResult, type RawEvent } from "../packages/oar/src/index.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-instant-interrupt");
await mkdir(out, { recursive: true });
const runtime = defaultRuntimes.require("codex");
const detected = await runtime.installation?.();
assert.ok(detected?.kind === "available", "Codex app-server must be installed");
const installation = detected;
const marker = "STEER_MARKER_9159";
const partial = "UNFINISHED_OLD_TEXT";
const commentary = "COMPLETED_COMMENTARY";

async function until(predicate: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${description}`);
    // Each observation depends on the previous predicate result.
    // eslint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

function message(id: string, text: string, phase: string): Record<string, unknown> {
  return { id, type: "message", role: "assistant", phase, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

async function probe(enabled: boolean, action: "steer" | "queue" | "abort", scenario: "stream" | "code-mode" | "direct-tool" = "stream"): Promise<Record<string, unknown>> {
  const name = `${scenario}-${enabled ? "on" : "off"}-${action}`;
  const home = await mkdtemp(path.join(tmpdir(), "oar-instant-interrupt-"));
  const requests: { atMs: number; body: unknown }[] = [];
  const records: { atMs: number; record: RawEvent }[] = [];
  const sockets = new Set<ServerResponse>();
  const start = Date.now();
  const held: { release?: () => void } = {};
  const server = createServer((req, res) => {
    sockets.add(res);
    res.on("close", () => { sockets.delete(res); });
    void (async (): Promise<void> => {
      try {
        const parts: Buffer[] = [];
        for await (const part of req) { parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part))); }
        if (req.method !== "POST" || req.url?.endsWith("/responses") !== true) {
          res.writeHead(404).end();
          return;
        }
        const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        const index = requests.length;
        requests.push({ atMs: Date.now() - start, body });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const responseId = `resp-${String(index)}`;
        let sequence = 0;
        const send = (type: string, fields: Record<string, unknown>): void => {
          if (!res.destroyed) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`); }
        };
        const sendMessage = (item: Record<string, unknown>, outputIndex: number, complete: boolean): void => {
          const content: unknown[] = Array.isArray(item.content) ? item.content : [];
          const first = asRecord(content[0]);
          const text = typeof first?.text === "string" ? first.text : "";
          send("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress", content: [] } });
          send("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          send("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: text });
          if (complete) {
            send("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text });
            send("response.output_item.done", { output_index: outputIndex, item });
          }
        };
        const finish = (output: Record<string, unknown>[]): void => {
          send("response.completed", { response: { id: responseId, object: "response", status: "completed", model: "gpt-5.1", output, usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } });
          res.end();
        };
        send("response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } });
        const sendTool = (item: Record<string, unknown>): void => {
          send("response.output_item.added", { output_index: 0, item });
          send("response.output_item.done", { output_index: 0, item });
          finish([item]);
        };
        if (index === 0 && scenario !== "stream") {
          const command = "python3 -c 'import time; time.sleep(3); print(\"CELL_DONE\")'";
          const argumentsText = JSON.stringify({ cmd: command, yield_time_ms: 5000 });
          sendTool(scenario === "code-mode"
            ? { id: "exec-item", type: "custom_tool_call", call_id: "exec-call", name: "exec", input: `// @exec: {"yield_time_ms": 30000}\nconst result = await tools.exec_command(${argumentsText}); text(result);` }
            : { id: "direct-item", type: "function_call", call_id: "direct-call", name: "exec_command", arguments: argumentsText });
          held.release = (): void => { /* The native tool owns its three-second lifetime. */ };
        } else if (index === 0) {
          const done = message("kept-commentary", commentary, "commentary");
          const incomplete = message("unfinished-item", partial, "final_answer");
          sendMessage(done, 0, true);
          sendMessage(incomplete, 1, false);
          held.release = (): void => {
            send("response.output_text.done", { item_id: incomplete.id, output_index: 1, content_index: 0, text: partial });
            send("response.output_item.done", { output_index: 1, item: incomplete });
            finish([done, incomplete]);
          };
        } else if (scenario === "code-mode" && index === 1 && JSON.stringify(body).includes("Script running with cell ID")) {
          const cell = /Script running with cell ID (?<cell>[\w-]+)/u.exec(JSON.stringify(body))?.groups?.cell;
          assert.ok(cell !== undefined, "yielded cell must expose a resumable ID");
          sendTool({ id: "wait-item", type: "function_call", call_id: "wait-call", name: "wait", arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 5000 }) });
        } else {
          const final = message(`final-${String(index)}`, "NEW_RESPONSE", "final_answer");
          sendMessage(final, 0, true);
          finish([final]);
        }
      } catch (error) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await writeFile(path.join(home, "config.toml"), [
    'model = "gpt-5.1"', 'model_provider = "probe"', 'preferred_auth_method = "apikey"',
    "[features]", `instant_interrupt = ${String(enabled)}`, `code_mode = ${String(scenario === "code-mode")}`, "[model_providers.probe]", 'name = "probe"',
    `base_url = "http://127.0.0.1:${String(address.port)}/v1"`, 'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"',
  ].join("\n"));
  const session = await runtime.session(installation, { cwd: home, model: "gpt-5.1", env: { CODEX_HOME: home, OPENAI_API_KEY: "local-probe-placeholder" } });
  session.rawEvents((record) => { records.push({ atMs: Date.now() - start, record }); });
  const ends = (): RawEvent[] => session.records().filter((record) => record.kind === "frame" && record.body.type === "turn/completed");
  try {
    await session.prompt("Start the original response", { inputId: randomUUID() });
    await until(() => session.records().some((record) => record.kind === "frame" && (scenario === "stream"
      ? record.body.type === "item/agentMessage/delta" && asRecord(record.body.native)?.delta === partial
      : record.body.events.some((event) => event.kind === "tool_call_started"))), "partial response or running tool");
    const actionAtMs = Date.now() - start;
    const identity = { inputId: randomUUID() };
    const control: ControlResult = action === "abort" ? await session.abort() : await (action === "queue" ? session.queue(marker, identity) : session.steer?.(marker, identity)) ?? assert.fail("a codex session has steer");
    assert.equal(control.response.body.kind, "accepted");
    if (enabled && action === "steer" && scenario !== "direct-tool") {
      await until(() => requests.length >= 2, "replacement while first response is held");
    } else {
      await delay(500);
      assert.equal(requests.length, 1, "control must not preempt this model response");
    }
    const beforeRelease = { requests: requests.length, turnEnds: ends().length };
    assert.ok(held.release !== undefined);
    held.release();
    await until(() => ends().length >= (action === "queue" ? 2 : 1), "native turn completion");
    if (action !== "abort") { await until(() => requests.length >= 2, "follow-up model request"); }
    const replacement = requests[1] === undefined ? null : JSON.stringify(requests[1].body);
    if (action !== "abort") {
      assert.ok(replacement !== null && replacement.includes(marker));
      if (scenario === "stream") {
        assert.ok(replacement.includes(commentary));
        assert.equal(replacement.includes(partial), !enabled || action === "queue", "unfinished output in replacement context");
      }
    }
    const outputs = requests.flatMap(({ body }) => {
      const input = asRecord(body)?.input;
      return Array.isArray(input) ? input.map((item: unknown) => asRecord(item)).filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output").map((item) => item?.output) : [];
    });
    if (scenario !== "stream") { assert.ok(JSON.stringify(outputs).includes("CELL_DONE"), "steering must preserve the eventual tool result"); }
    if (scenario === "code-mode" && enabled) {
      assert.ok(JSON.stringify(outputs[0]).includes("Script running with cell ID"), "enabled exec must yield a running cell");
      assert.ok(requests.length >= 3, "the yielded cell must be collected by wait before the final answer");
    }
    for (const [index, record] of session.records().entries()) { assert.equal(record.seq, index, "dense record sequence"); }
    const nativeEnds = ends().map((record) => record.kind === "frame" ? asRecord(asRecord(record.body.native)?.turn) : null);
    assert.equal(nativeEnds.length, action === "queue" ? 2 : 1);
    assert.equal(nativeEnds[0]?.status, action === "abort" ? "interrupted" : "completed");
    assert.equal(session.records().filter((record) => record.kind === "frame" && record.body.type === "turn/started").length, nativeEnds.length, "preemption must not create another native turn");
    const itemFinished = session.records().some((record) => record.kind === "frame" && record.body.type === "item/completed" && asRecord(asRecord(record.body.native)?.item)?.id === "unfinished-item");
    const report = { name, enabled, action, scenario, beforeRelease, actionAtMs,
      replacementAfterMs: requests[1] === undefined ? null : requests[1].atMs - actionAtMs,
      nativeEnds, unfinishedItemCompleted: itemFinished,
      replacementHasPartial: replacement?.includes(partial) ?? null,
      toolOutputs: outputs, status: session.status().value, requests, records };
    await writeFile(path.join(out, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const summary = { name, beforeRelease, replacementAfterMs: report.replacementAfterMs, nativeEnds, unfinishedItemCompleted: itemFinished, replacementHasPartial: report.replacementHasPartial };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    await session.dispose();
    for (const socket of sockets) { socket.destroy(); }
    await server[Symbol.asyncDispose]();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// Sequential native processes keep the timing observations independent.
const results = [
  await probe(false, "steer"),
  await probe(true, "steer"),
  await probe(true, "queue"),
  await probe(true, "abort"),
  await probe(false, "steer", "code-mode"),
  await probe(true, "steer", "code-mode"),
  await probe(true, "steer", "direct-tool"),
];
await writeFile(path.join(out, "summary.json"), `${JSON.stringify({ checkedAt: new Date().toISOString(), installation, results }, null, 2)}\n`);
