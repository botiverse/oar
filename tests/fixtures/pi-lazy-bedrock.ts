// A fresh process records native module loads during an actual Pi open and
// auth query. Every config file and session lives in the supplied temp dir.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";

const [directory] = process.argv.slice(2);
assert.ok(directory !== undefined);
const agentDir = join(directory, "agent");
await mkdir(agentDir, { recursive: true });
process.env.OAR_PI_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_PACKAGE_DIR;
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { isolated: {
  name: "isolated", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "synthetic",
  models: [{ id: "no-inference", name: "no-inference", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 }],
} } }));
const loaded: string[] = [];
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.includes("/api/bedrock-converse-stream.js") || url.includes("/@aws-sdk/") || url.includes("/@aws-sdk+")) { loaded.push(url); }
  return nextLoad(url, context);
} });
try {
  const { createPiSession } = await import("../../packages/oar/src/runtimes/pi/session.js");
  const session = await createPiSession({ projectTrusted: false })({ kind: "available", via: "bundled" }, { cwd: directory, model: "isolated/no-inference" });
  await session.dispose();
  const afterOpen = loaded.length;
  const { createPiProviderAuth } = await import("../../packages/oar/src/runtimes/pi/auth.js");
  const auth = await createPiProviderAuth({ authPath: join(agentDir, "empty-auth.json"), modelsPath: null });
  const providers = auth.loginProviders();
  assert.ok(providers.some(provider => provider.providerId === "amazon-bedrock"));
  assert.deepEqual(await auth.listProviders({ resolve: false }), []);
  const afterAuth = loaded.length;
  process.stdout.write(`${JSON.stringify({ afterOpen, afterAuth })}\n`);
  assert.deepEqual(loaded, [], "opening Pi and querying auth must not load Bedrock or AWS implementations");
} finally { hook.deregister(); }
