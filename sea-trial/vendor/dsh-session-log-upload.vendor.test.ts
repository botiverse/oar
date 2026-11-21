import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dshRuntime, type RawEvent } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { dshEnabled } from "./support/dsh-fixture.js";

interface CapturedRequest {
  readonly sessionId: string | null;
  readonly hasSessionLog: boolean;
  readonly hasPluginPackages: boolean;
}

interface MockDeepSeekServer {
  readonly url: string;
  readonly requests: CapturedRequest[];
  stop(): Promise<void>;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function writeReply(res: http.ServerResponse, id: string, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
  res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
  res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }));
  res.write(sse("message_stop", { type: "message_stop" }));
  res.end();
}

function writeSubagentToolCall(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(sse("message_start", { type: "message_start", message: { id: "m_sub", type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } }));
  res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_sub1", name: "subagent", input: {} } }));
  res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ prompt: "reply child-ok", description: "child upload check" }) } }));
  res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } }));
  res.write(sse("message_stop", { type: "message_stop" }));
  res.end();
}

function hasToolResult(body: Record<string, unknown> | null): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((item) => {
    const content = asRecord(item)?.content;
    return Array.isArray(content) && content.some((block) => asRecord(block)?.type === "tool_result");
  });
}

function hasSubagentTool(body: Record<string, unknown> | null): boolean {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some((tool) => asRecord(tool)?.name === "subagent");
}

async function startLoopbackDeepSeek(spawnChildOnFirstCall: boolean): Promise<MockDeepSeekServer> {
  const requests: CapturedRequest[] = [];
  let messageCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const body = asRecord(parseJson(Buffer.concat(chunks).toString("utf8")));
      if (req.url?.includes("/models") === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }] }));
        return;
      }
      if (req.url?.includes("/messages") === true) {
        messageCalls += 1;
        const header = req.headers["x-deepseek-harness-session-id"];
        requests.push({
          sessionId: typeof header === "string" ? header : null,
          hasSessionLog: body !== null && "dsh_session_log" in body,
          hasPluginPackages: body !== null && "dsh_plugin_packages" in body,
        });
        if (spawnChildOnFirstCall && messageCalls === 1 && hasSubagentTool(body) && !hasToolResult(body)) {
          writeSubagentToolCall(res);
          return;
        }
      }
      writeReply(res, `msg_${String(messageCalls)}`, "ok");
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => { resolve(); }); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    stop: async () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

function deliveryAcceptedFrames(records: readonly RawEvent[]): readonly RawEvent[] {
  return records.filter((record) => record.kind === "frame" && record.body.type === "session/event:session-log-deepseek/delivery-accepted");
}

async function waitForSubagentSettlement(session: Awaited<ReturnType<typeof dshRuntime.session>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let childEnded = false;
    const timer = setTimeout(() => { reject(new Error("timed out waiting for subagent settlement")); }, 20_000);
    const check = (): void => {
      if (childEnded && session.status().value.kind === "idle") { clearTimeout(timer); off(); resolve(); }
    };
    const off = session.rawEvents((record) => {
      if (record.kind === "frame" && record.body.type === "subagent/end") { childEnded = true; }
      check();
    });
    for (const record of session.records()) {
      if (record.kind === "frame" && record.body.type === "subagent/end") { childEnded = true; }
    }
    check();
  });
}

async function withOfficialDeepSeekHome<T>(
  spawnChild: boolean,
  homePatch: readonly unknown[] | null,
  body: (fixture: { readonly cwd: string; readonly dshHome: string; readonly env: Readonly<Record<string, string>>; readonly server: MockDeepSeekServer }) => Promise<T>,
): Promise<T> {
  const server = await startLoopbackDeepSeek(spawnChild);
  const root = await mkdtemp(path.join(tmpdir(), "oar-dsh-session-log-vendor-"));
  const home = path.join(root, "home");
  const dshHome = path.join(root, "dsh");
  const cwd = path.join(root, "project");
  await Promise.all([home, dshHome, cwd].map(async (directory) => { await mkdir(directory); }));
  if (homePatch !== null) {
    await writeFile(path.join(dshHome, "cordis.patch.yml"), `${JSON.stringify(homePatch)}\n`);
  }
  const env = {
    HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
    DEEPSEEK_BASE_URL: server.url, DEEPSEEK_API_KEY: "sk-synthetic-session-log-test",
    DSH_TELEMETRY_DISABLED: "1", NO_PROXY: "*",
  };
  try { return await body({ cwd, dshHome, env, server }); }
  finally { await server.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}

async function runCompletedPrompt(session: Awaited<ReturnType<typeof dshRuntime.session>>, text: string): Promise<void> {
  const started = await session.prompt(text);
  expect(started.kind).toBe("accepted");
  expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
}

describe.skipIf(!dshEnabled)("DSH sessionLogUpload", () => {
  test("default official DeepSeek launch sends dsh_session_log and records delivery-accepted", async () => {
    const installation = await dshRuntime.installation();
    assert.equal(installation.kind, "available");
    await withOfficialDeepSeekHome(false, null, async ({ cwd, env, server }) => {
      const session = await dshRuntime.session(installation, { cwd, env, model: "deepseek-official/deepseek-flash" });
      await runCompletedPrompt(session, "hello");
      expect(server.requests.some((request) => request.hasSessionLog)).toBe(true);
      expect(deliveryAcceptedFrames(session.records()).length).toBeGreaterThan(0);
      await session.dispose();
    });
  }, 60_000);

  test("sessionLogUpload: 'off' stops dsh_session_log across root, subagent child, and resume even over home enabled: true", async () => {
    const installation = await dshRuntime.installation();
    assert.equal(installation.kind, "available");
    await withOfficialDeepSeekHome(true, [{ id: "session-log-deepseek", config: { enabled: true } }], async ({ cwd, dshHome, env, server }) => {
      const patchPath = path.join(dshHome, "cordis.patch.yml");
      const beforePatch = await readFile(patchPath, "utf8");
      const first = await dshRuntime.session(installation, { cwd, env, model: "deepseek-official/deepseek-flash", sessionLogUpload: "off" });
      await runCompletedPrompt(first, "delegate");
      await waitForSubagentSettlement(first);
      expect(deliveryAcceptedFrames(first.records())).toHaveLength(0);
      const sessionId = first.id;
      await first.dispose();
      const resumed = await dshRuntime.session(installation, { cwd, env, resume: sessionId, model: "deepseek-official/deepseek-flash", sessionLogUpload: "off" });
      await runCompletedPrompt(resumed, "after resume");
      expect(deliveryAcceptedFrames(resumed.records())).toHaveLength(0);
      await resumed.dispose();
      expect(server.requests.some((request) => request.sessionId !== null && request.sessionId !== sessionId)).toBe(true);
      expect(server.requests.every((request) => !request.hasSessionLog)).toBe(true);
      expect(await readFile(patchPath, "utf8")).toBe(beforePatch);
    });
  }, 60_000);
});
