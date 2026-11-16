// The real lazy provider must work from one bundled file with no pi-ai
// files alongside it. The caller supplies a loopback HTTP test endpoint.
import assert from "node:assert/strict";
import { bedrockConverseStreamApi } from "../../node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.lazy.js";
import { normalizeContext } from "../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { providePiModules } from "../../packages/oar/src/runtimes/pi/static-modules.js";

const [baseUrl] = process.argv.slice(2);
assert.ok(baseUrl !== undefined && baseUrl.startsWith("http://127.0.0.1:"));
await providePiModules();
const stream = bedrockConverseStreamApi().stream({
  id: "probe-model", name: "probe-model", api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl,
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 1024,
}, normalizeContext({ messages: [{ role: "user", content: "local probe", timestamp: 0 }] }), {
  signal: AbortSignal.timeout(10_000),
  env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1", AWS_REGION: "us-east-1" },
});
const result = await stream.result();
assert.equal(result.stopReason, "error");
assert.match(result.errorMessage ?? "", /local-bedrock-probe/u);
process.stdout.write("bedrock reached local provider\n");
