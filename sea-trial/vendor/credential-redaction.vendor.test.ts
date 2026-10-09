import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { LLMock } from "@copilotkit/aimock";
import { claudeInstallation, claudeSession, piSession, type RawEvent, type Session } from "../../packages/oar/src/index.js";
import { runTurn, withProcessEnv } from "./support/asserts.js";

const firstKey = "oar-provider-echo-secret-one";
const secondKey = "oar-provider-echo-secret-two";
const diagnosticPath = "/workspace/provider-diagnostic-path";

/** A provider that actually reflects the authentication header in its error body. */
async function echoProvider(): Promise<{ url: string; keys: string[]; stop(): Promise<void> }> {
  const keys: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const key = String(request.headers["x-api-key"] ?? request.headers.authorization ?? "");
      keys.push(key);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `rejected credential ${key}; path ${diagnosticPath}` } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") { throw new Error("provider did not bind a TCP port"); }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    keys,
    stop: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) { reject(error); } else { resolve(); } }); }); },
  };
}

async function preparePi(directory: string, url: string): Promise<void> {
  const model = { id: "model", name: "model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1024 };
  const provider = (key: string): unknown => ({ api: "anthropic-messages", baseUrl: url, apiKey: key, models: [model] });
  await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: { first: provider(firstKey), second: provider(secondKey) } }));
  await mkdir(path.join(directory, "extensions"));
  await writeFile(path.join(directory, "extensions", "switch.ts"), `
export default (pi) => {
  pi.on("input", async (event, context) => {
    if (event.text === "second") {
      const model = context.modelRegistry.find("second", "model");
      if (!model || !await pi.setModel(model)) throw new Error("model switch failed");
    }
  });
};
`);
}

async function exercise(session: Session, keys: string[], changeModel: boolean): Promise<void> {
  const live: RawEvent[] = [];
  session.rawEvents((record) => { live.push(record); }, { sessionId: session.id, afterSeq: -1 });
  const first = await runTurn(session, "first");
  expect(first).toMatchObject({ kind: "failed" });
  expect(keys.some((key) => key.includes(firstKey))).toBe(true);
  const second = changeModel ? await runTurn(session, "second") : null;
  if (changeModel) { expect(keys.some((key) => key.includes(secondKey))).toBe(true); }
  await session.dispose();
  const replay: RawEvent[] = [];
  session.rawEvents((record) => { replay.push(record); }, { sessionId: session.id, afterSeq: -1 });
  expect(live).toEqual(session.records());
  expect(replay).toEqual(live);
  expect(JSON.stringify(session.records())).toContain(diagnosticPath);
  expect(JSON.stringify(first)).toContain("[redacted]");
  if (second !== null) { expect(JSON.stringify(second)).toContain("[redacted]"); }
  for (const value of [session.records(), live, replay, first, second, session.status()]) {
    for (const text of [JSON.stringify(value), inspect(value, { depth: null })]) {
      expect(text).not.toContain(firstKey);
      expect(text).not.toContain(secondKey);
    }
  }
}

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude provider-echoed env key is absent from records, outcomes, replay and diagnostics", async () => {
  const provider = await echoProvider();
  const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-credential-test-"));
  let session: Session | undefined = undefined;
  try {
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error("Claude installation unavailable"); }
    session = await claudeSession(installation, { cwd: directory, env: { ANTHROPIC_BASE_URL: provider.url, ANTHROPIC_API_KEY: firstKey, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CONFIG_DIR: directory, DIAGNOSTIC_PATH: diagnosticPath } });
    await exercise(session, provider.keys, false);
  } finally {
    await session?.dispose();
    await provider.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi provider-echoed SDK keys are removed at open and after a native model change", async () => {
  const provider = await echoProvider();
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-credential-test-"));
  try {
    await preparePi(directory, provider.url);
    await withProcessEnv({ OAR_PI_AGENT_DIR: directory, PI_PACKAGE_DIR: "" }, async () => {
      const session = await piSession({ kind: "available", via: "bundled" }, { cwd: directory, model: "first/model", env: { DIAGNOSTIC_PATH: diagnosticPath } });
      try { await exercise(session, provider.keys, true); } finally { await session.dispose(); }
    });
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);


test.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi short local-provider keys preserve model IDs and response text", async () => {
  const mock = new LLMock({ port: 0 });
  mock.onMessage("hello", { content: "ollama says hello" });
  await mock.start();
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-short-key-test-"));
  try {
    const model = { id: "ollama-model", name: "ollama-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1024 };
    await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: { ollama: { api: "anthropic-messages", baseUrl: mock.url, apiKey: "ollama", models: [model] } } }));
    await withProcessEnv({ OAR_PI_AGENT_DIR: directory, PI_PACKAGE_DIR: "" }, async () => {
      const session = await piSession({ kind: "available", via: "bundled" }, { cwd: directory, model: "ollama/ollama-model" });
      try {
        let text = "";
        session.events((event) => { if (event.kind === "text_delta") { text += event.text; } });
        await expect(runTurn(session, "hello")).resolves.toEqual({ kind: "completed" });
        expect(session.model().value).toBe("ollama/ollama-model");
        expect(text).toBe("ollama says hello");
        expect(JSON.stringify(session.records())).not.toContain("[redacted]");
      } finally { await session.dispose(); }
    });
  } finally {
    await mock.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);
