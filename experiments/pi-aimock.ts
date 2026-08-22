/**
 * Probe: can pi's model plane be pointed at a local scripted provider
 * (aimock) via a temp agentDir models.json? Recipe under test:
 *   {providers: {aimock: {baseUrl, apiKey, api: "anthropic-messages", models:[...]}}}
 * Success = a prompted turn completes with the scripted "ok".
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";

delete process.env.PI_PACKAGE_DIR; // the Raft daemon injects its own; it must not leak into this probe

const mock = new LLMock({ port: 0 });
mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 80 });
await mock.start();

const agentDir = await mkdtemp(path.join(tmpdir(), "oar-pi-aimock-"));
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    aimock: {
      name: "aimock",
      baseUrl: mock.url,
      apiKey: "aimock",
      api: "anthropic-messages",
      models: [{
        id: "aimock-model",
        name: "aimock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 16_384,
      }],
    },
  },
}, null, 2));

const sdk = await import("@earendil-works/pi-coding-agent");
const { session } = await sdk.createAgentSession({ cwd: process.cwd(), agentDir });
console.log("session:", session.sessionId);
const timer = setTimeout(() => {
  console.log("TIMEOUT: no settlement in 30s");
  process.exit(2);
}, 30_000);
session.subscribe((event) => {
  console.log("event:", event.type);
});
await session.prompt("hello");
clearTimeout(timer);
console.log("prompt resolved — turn completed");
await mock.stop();
process.exit(0);
