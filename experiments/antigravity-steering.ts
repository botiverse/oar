/**
 * Does a busy ACP prompt steer Antigravity or wait for another turn?
 * OAR_ANTIGRAVITY_BIN=/path/to/agy_acp_server.par pnpm tsx experiments/antigravity-steering.ts
 * Keep localharness_external beside it. Isolated homes, local Gemini provider
 * and echo MCP server, dummy credentials, no account or quota. The first model
 * response is held while the second prompt is sent, then calls a tool before
 * completing: the next provider request reveals whether input joined that loop.
 */
/* oxlint-disable eslint/no-await-in-loop, typescript/promise-function-async -- Ordered native experiments; RPC callbacks return SDK promises. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";
import { ECHO_SERVER } from "../sea-trial/vendor/support/echo-mcp.js";

const command = process.env.OAR_ANTIGRAVITY_BIN;
assert.ok(command !== undefined && command.length > 0, "Set OAR_ANTIGRAVITY_BIN to the server under test");
const directory = path.resolve(process.env.OAR_PROBE_DIR ?? "oar-trial-run/antigravity-steering");
await mkdir(directory, { recursive: true });
const firstMarker = "OAR_FIRST_REQUEST_9571";
const secondMarker = "OAR_SECOND_REQUEST_2846";
const firstAnswer = "FIRST_LOOP_FINISHED";
const secondAnswer = "SECOND_LOOP_FINISHED";
const toolMarker = "steering-tool-result";

interface ProviderObservation {
  readonly at: number;
  readonly first: boolean;
  readonly second: boolean;
  readonly toolResult: boolean;
  readonly firstAnswer: boolean;
}

async function probe(binary: string, index: number, concurrent: boolean): Promise<object> {
  const start = Date.now();
  const firstSeen = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const requests: ProviderObservation[] = [];
  const wire: object[] = [];
  const updates: object[] = [];
  const time = (): number => Date.now() - start;
  const env = await startAntigravityAimock((mock) => {
    mock.on({ predicate: () => true }, async (request) => {
      const content = JSON.stringify(request.messages);
      const observation = {
        at: time(), first: content.includes(firstMarker), second: content.includes(secondMarker),
        toolResult: content.includes(`echo:${toolMarker}`), firstAnswer: content.includes(firstAnswer),
      };
      requests.push(observation);
      if (observation.second) { return { content: secondAnswer }; }
      if (observation.toolResult) { return { content: firstAnswer }; }
      assert.ok(observation.first, "Unexpected provider request");
      firstSeen.resolve();
      await releaseFirst.promise;
      return { toolCalls: [{ id: "call_echo", name: "call_mcp_tool", arguments: JSON.stringify({
        ServerName: "echo", ToolName: "echo", Arguments: { text: toolMarker },
        toolSummary: "Echo a probe marker", toolAction: "Echoing",
      }) }] };
    });
  });
  const home = env.env.HOME;
  assert.ok(home !== undefined);
  const app = createAcpClient({ name: "oar-steering-probe" })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push({ at: time(), ...params }); });
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SystemRoot"].includes(key)));
  const native = startAcpProcess(binary, process.platform === "linux" ? ["--uid="] : [], app, {
    cwd: home, env: { ...inherited, ...env.env },
    incoming: (message) => { wire.push({ at: time(), direction: "in", message }); return message; },
    outgoing: (message) => { wire.push({ at: time(), direction: "out", message }); },
  });
  const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(
    await withAcpDeadline(native, method, 60_000, (options) => native.connection.agent.request(method, params, options)),
  ) ?? {};
  let expired = false;
  const timer = setTimeout(() => { expired = true; releaseFirst.resolve(); firstSeen.resolve(); native.kill(); }, 75_000);
  const name = `${String(index)}-${concurrent ? "busy" : "sequential"}`;
  const outcomes: object[] = [];
  try {
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar-steering-probe", version: "0.0.0" } });
    const opened = await request("session/new", {
      cwd: home, mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER], env: [] }],
    });
    const { sessionId } = opened;
    assert.equal(typeof sessionId, "string");
    await request("session/set_mode", { sessionId, modeId: "yolo" });
    const prompt = async (text: string): Promise<JsonRecord> => {
      const sentAt = time();
      try {
        const reply = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        outcomes.push({ text, sentAt, replyAt: time(), reply });
        return reply;
      } catch (error) {
        outcomes.push({ text, sentAt, errorAt: time(), error: String(error) });
        throw error;
      }
    };
    const first = prompt(firstMarker);
    // Attach handlers immediately so a native early rejection is evidence,
    // not an unhandled promise while the probe waits for its model barrier.
    // oxlint-disable-next-line promise/prefer-await-to-then -- Observe early rejection while the barrier is pending.
    void first.catch(() => {});
    await firstSeen.promise;
    assert.equal(expired, false, "First provider request did not arrive");
    let second: Promise<JsonRecord> | undefined = undefined;
    if (concurrent) {
      second = prompt(secondMarker);
      // oxlint-disable-next-line promise/prefer-await-to-then -- Observe early rejection while the barrier is pending.
      void second.catch(() => {});
      await delay(250);
    }
    const beforeRelease = { at: time(), requestCount: requests.length, replyCount: outcomes.length };
    releaseFirst.resolve();
    const firstReply = await first;
    second ??= prompt(secondMarker);
    const secondReply = await second;
    const messages = updates.flatMap((value) => {
      const update = asRecord(asRecord(value)?.update);
      return update?.sessionUpdate === "agent_message_chunk"
        ? [{ at: asRecord(value)?.at, text: asRecord(update.content)?.text }] : [];
    });
    const observation = { name, agentInfo: initialized.agentInfo, beforeRelease, requests, outcomes, messages };
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(observation, null, 2));
    assert.equal(expired, false);
    assert.equal(firstReply.stopReason, "end_turn");
    assert.equal(secondReply.stopReason, "end_turn");
    assert.equal(beforeRelease.requestCount, 1, "A second inference began before the held response was released");
    assert.equal(beforeRelease.replyCount, 0);
    assert.deepEqual(requests.map(({ at: _at, ...body }) => body), [
      { first: true, second: false, toolResult: false, firstAnswer: false },
      { first: true, second: false, toolResult: true, firstAnswer: false },
      { first: true, second: true, toolResult: true, firstAnswer: true },
    ]);
    const text = messages.map((message) => message.text).join("");
    assert.ok(text.includes(firstAnswer), "First loop's reply was not delivered over ACP");
    assert.ok(text.includes(secondAnswer), "Second loop's reply was not delivered over ACP");
    return observation;
  } finally {
    clearTimeout(timer);
    releaseFirst.resolve();
    native.kill();
    await native.exited;
    await writeFile(path.join(directory, `${name}-wire.json`), JSON.stringify(wire, null, 2));
    await env.stop();
  }
}

const results: object[] = [];
for (const [index, concurrent] of [false, true, true, true].entries()) {
  results.push(await probe(command, index, concurrent));
}
await writeFile(path.join(directory, "evidence.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
