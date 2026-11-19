/* oxlint-disable promise/avoid-new -- The loopback server exposes callback-based listen and close. */
import assert from "node:assert/strict";
import { stdioEcho } from "../../sea-trial/vendor/support/echo-mcp.js";
import { createServer } from "node:http";
import { antigravityRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";

const [binary] = process.argv.slice(2);
assert.ok(binary !== undefined && binary !== "", "Pass the path to agy");
const home = await startAntigravityAimock(() => {});
let injected = 0;
let toolSent = false;
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  request.on("end", () => {
    const payload = Buffer.concat(chunks).toString("utf8");
    const tool = !toolSent && payload.includes("MEASURE_TOOL_TURN") && !payload.includes("conversation title generator");
    if (tool) { toolSent = true; }
    const part = tool ? { functionCall: { name: "mcp_echo_echo", args: { text: "usage probe", toolSummary: "Echo" } } } : { text: "LOCAL_CACHE_TEST" };
    const usageMetadata = {
      promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 108,
      // Deliberately synthetic additions. Neither is a verified Gemini cache-write field.
      ...(injected === 0 ? {} : { cachedWriteTokens: injected, cacheCreationInputTokens: injected }),
    };
    const answer = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [part] }, index: 0, finishReason: "STOP" }], usageMetadata,
    });
    const stream = request.url?.includes("streamGenerateContent") === true;
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    response.end(stream ? `data: ${answer}\n\n` : answer);
  });
});
try {
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object" && home.env.HOME !== undefined);
  const session = await antigravityRuntime.session({ kind: "available", via: "executable", command: binary }, {
    mcpServers: [stdioEcho("echo")],
    cwd: home.env.HOME, env: { ...home.env, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${String(address.port)}` }, model: "gemini-3.8-flash",
  });
  try {
    for (const prompt of ["Baseline", "Inject write count", "MEASURE_TOOL_TURN"]) {
      injected = prompt === "Inject write count" ? 11 : 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Consecutive replies on one session distinguish per-prompt from cumulative accounting.
      const run = await promptAndWait(session, prompt);
      assert.ok(run.kind === "ended" && run.outcome.kind === "completed");
      const frame = session.records().findLast(record => record.kind === "frame" && record.body.type === "session/prompt");
      assert.ok(frame?.kind === "frame");
      const calls = prompt === "MEASURE_TOOL_TURN" ? 2 : 1;
      assert.deepEqual(frame.body.native, { stopReason: "end_turn", usage: {
        inputTokens: 80 * calls, outputTokens: 8 * calls, cachedReadTokens: 20 * calls,
        cachedWriteTokens: 0, thoughtTokens: 3 * calls, totalTokens: 108 * calls,
      } });
      console.log(JSON.stringify({ prompt, injected, response: frame.body.native }));
    }
  } finally { await session.dispose(); }
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  await home.stop();
}
