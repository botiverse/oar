import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, onTestFailed, test } from "vitest";
import { promptAndWait, qwenRuntime } from "../../packages/oar/src/index.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";
import { currentTurnSays, stdioEcho } from "./support/echo-mcp.js";
import { expectAvailable } from "./support/asserts.js";

type Environment = Awaited<ReturnType<typeof startQwenAimock>>;
const tool = "mcp__echo__echo";
const call = (id: string, text: string) => ({ id, name: tool, arguments: JSON.stringify({ text }) });
const echo = (text: string) => `echo:${text} via=stdio token=none`;

async function open(env: Environment, resume?: string): Promise<Session> {
  const installation = await qwenRuntime.installation();
  expectAvailable(installation, `Qwen: ${JSON.stringify(installation)}`);
  return qwenRuntime.session(installation, { cwd: env.cwd, env: env.env, mcpServers: [stdioEcho("echo")], ...(resume === undefined ? {} : { resume }) });
}

function preserveFailure(name: string, env: Environment, sessions: readonly Session[], outgoing: readonly string[] = []): void {
  onTestFailed(async () => {
    await mkdir("oar-trial-run/qwen-vendor", { recursive: true });
    await writeFile(`oar-trial-run/qwen-vendor/tool-ids-${name}.json`, JSON.stringify({ provider: env.raw, outgoing, records: sessions.map((session) => session.records()) }, null, 2));
  });
}

function toolRecords(session: Session) {
  const frames = session.records().flatMap((record) => record.kind === "frame" ? [record.body] : []);
  const events = frames.flatMap((frame) => frame.events);
  const blocks = frames.flatMap((frame) => {
    const content = asRecord(asRecord(frame.native)?.message)?.content;
    return asRecordList(content);
  });
  return {
    starts: events.filter((event) => event.kind === "tool_call_started"),
    ends: events.filter((event) => event.kind === "tool_call_ended"),
    calls: blocks.filter((block) => block.type === "tool_use"),
    results: blocks.filter((block) => block.type === "tool_result"),
  };
}

function toolDeltas(body: string) {
  return body.split("\n").flatMap((line) => {
    const chunk = line.startsWith("data: ") ? asRecord(parseJson(line.slice(6))) : null;
    return asRecordList(chunk?.choices).flatMap((choice) => asRecordList(asRecord(choice.delta)?.tool_calls));
  });
}

/** Check the actual SSE, including retries, before attributing failure to Qwen. */
function verifyBatch(body: string, batch: readonly ReturnType<typeof call>[], fragmented: boolean): void {
  const deltas = toolDeltas(body);
  expect([...new Set(deltas.map((delta) => delta.index))]).toEqual([0, 1, 2]);
  batch.forEach((entry, index) => {
    const parts = deltas.filter((delta) => delta.index === index);
    expect(parts[0]).toEqual({ index, id: entry.id, type: "function", function: { name: entry.name, arguments: fragmented ? "" : entry.arguments } });
    // OpenAI's streaming format identifies later fragments by index, not id:
    // https://developers.openai.com/api/docs/guides/function-calling#streaming
    expect(parts.length).toBeGreaterThan(fragmented ? 1 : 0);
    for (const part of parts.slice(1)) {
      const args = asRecord(part.function)?.arguments;
      expect(typeof args).toBe("string");
      expect(part).toEqual({ index, function: { arguments: args } });
    }
    expect(parts.map((part) => asRecord(part.function)?.arguments).join("")).toBe(entry.arguments);
  });
}

async function completed(session: Session, input: string): Promise<void> {
  expect(await promptAndWait(session, input, { timeoutMs: 45_000 }), JSON.stringify(session.records())).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
}

describe.skipIf(process.env.OAR_TEST !== "qwen-aimock")("Qwen native tool-call identities", () => {
  test.each(["different", "identical"] as const)("a reused provider id with %s arguments is recorded under its normalized identity on resume", async (args) => {
    const resumedText = args === "different" ? "resumed" : "fresh";
    const env = await startQwenAimock((mock) => {
      mock.on({ predicate: currentTurnSays(/fresh call/u) }, { toolCalls: [call("call_0", "fresh")] });
      mock.on({ predicate: currentTurnSays(/resumed call/u) }, { toolCalls: [call("call_0", resumedText)] });
      // Qwen appends a memory reminder after the tool result. End that turn
      // regardless of whether the native tool result reports success or replay.
      mock.on({ predicate: (request) => !currentTurnSays(/(fresh|resumed) call/u)(request) }, { content: "done" });
    });
    const sessions: Session[] = [];
    preserveFailure(args, env, sessions);
    try {
      const first = await open(env); sessions.push(first);
      try {
        await completed(first, "fresh call");
        const records = toolRecords(first);
        expect(records.starts.map((event) => event.callId)).toEqual(["call_0"]);
        expect(records.ends).toEqual([{ kind: "tool_call_ended", callId: "call_0", result: "ok", content: [{ type: "text", text: echo("fresh") }] }]);
      } finally { await first.dispose(); }
      const resumed = await open(env, first.id); sessions.push(resumed);
      try {
        await completed(resumed, "resumed call");
        const records = toolRecords(resumed);
        const normalized = "call_0__qwen_dup_2";
        expect(records.starts.map((event) => event.callId)).toEqual([normalized]);
        expect(records.calls).toEqual([{ type: "tool_use", id: normalized, name: tool, input: { text: resumedText } }]);
        expect(records.ends).toHaveLength(1);
        expect(records.results).toHaveLength(1);
        if (args === "different") {
          expect(records.ends).toEqual([{ kind: "tool_call_ended", callId: normalized, result: "ok", content: [{ type: "text", text: echo("resumed") }] }]);
          expect(records.results[0]).toMatchObject({ tool_use_id: normalized, is_error: false, content: echo("resumed") });
        } else {
          expect(records.results).toMatchInlineSnapshot(`
            [
              {
                "content": "Duplicate provider tool call id "call_0" was already handled. The duplicate tool call was ignored and not executed again. If you intended to run this tool again, re-issue the call with a new unique tool-call id (or explicitly different arguments).",
                "is_error": true,
                "tool_use_id": "call_0__qwen_dup_2",
                "type": "tool_result",
              },
            ]
          `);
          expect(records.ends).toEqual([{ kind: "tool_call_ended", callId: normalized, result: "failed", content: [{ type: "text", text: records.results[0]?.content }] }]);
          expect(JSON.stringify(records.results)).not.toContain(echo("fresh"));
        }
      } finally { await resumed.dispose(); }
    } finally { await env.stop(); }
  }, 90_000);

  test.each(["complete", "fragmented"] as const)("same-response duplicate ids with %s argument deltas retain the native outcome", async (shape) => {
    const batch = [call("call_0", "kept"), call("call_0", "dropped"), call("call_1", "independent")];
    const outgoing: string[] = [];
    // aimock normally sends each id/name first and then id-less argument
    // fragments. Also exercise complete calls in one SSE delta. Duplicate ids
    // are deliberately injected; the fragment layout follows OpenAI's format.
    const rewrite = (body: string) => {
      if (shape === "fragmented" || toolDeltas(body).length === 0) { outgoing.push(body); return body; }
      const envelope = { id: "duplicate-batch", object: "chat.completion.chunk", model: "gpt-5.1", created: 1 };
      const tool_calls = batch.map((entry, index) => ({ index, id: entry.id, type: "function", function: { name: entry.name, arguments: entry.arguments } }));
      const frames = [
        { ...envelope, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] },
        { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      const wire = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
      outgoing.push(wire);
      return wire;
    };
    const env = await startQwenAimock((mock) => {
      mock.on({ predicate: currentTurnSays(/duplicate batch/u) }, { toolCalls: batch });
      mock.on({ predicate: (request) => !currentTurnSays(/duplicate batch/u)(request) }, { content: "done" });
    }, rewrite);
    const sessions: Session[] = [];
    preserveFailure(`same-response-${shape}`, env, sessions, outgoing);
    try {
      const session = await open(env); sessions.push(session);
      try {
        const result = await promptAndWait(session, "duplicate batch", { timeoutMs: 45_000 });
        const records = toolRecords(session);
        const batches = outgoing.filter((body) => toolDeltas(body).length > 0);
        expect(batches.length).toBeGreaterThan(0);
        for (const body of batches) { verifyBatch(body, batch, shape === "fragmented"); }
        if (shape === "fragmented") {
          expect(result.kind).toBe("ended");
          expect("outcome" in result ? result.outcome : null).toMatchInlineSnapshot(`
            {
              "failure": "unknown",
              "kind": "failed",
              "reason": "[API Error: Model response contained a malformed tool call.]",
            }
          `);
          expect(records).toEqual({ starts: [], ends: [], calls: [], results: [] });
          return;
        }
        expect(result).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
        expect(batches).toHaveLength(1);
        expect(records.starts.map((event) => event.callId).toSorted()).toEqual(["call_0", "call_1"]);
        expect(records.ends.toSorted((a, b) => a.callId.localeCompare(b.callId))).toEqual([
          { kind: "tool_call_ended", callId: "call_0", result: "ok", content: [{ type: "text", text: echo("kept") }] },
          { kind: "tool_call_ended", callId: "call_1", result: "ok", content: [{ type: "text", text: echo("independent") }] },
        ]);
        expect(records.calls.map((block) => ({ id: block.id, input: block.input }))).toEqual([
          { id: "call_0", input: { text: "kept" } }, { id: "call_1", input: { text: "independent" } },
        ]);
        expect(records.results).toHaveLength(2);
        expect(JSON.stringify(session.records())).not.toContain("dropped");
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);
});
