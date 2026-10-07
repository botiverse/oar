/**
 * Native Grok ACP -> local model request probe. No login or model quota.
 * Run: OAR_GROK_BIN=/path/to/grok pnpm tsx experiments/grok-prompt-options.ts
 *
 * Observed 2026-10-07, 1.0.46 (2765805b9442): native override wins over rules;
 * resume ignores new rules but honors override. The OAR mapping must combine
 * both options into one override and refuse append-only resume.
 *
 * Uses a disposable GROK_HOME and a custom model pointed at loopback. The
 * provider returns a deliberate 400 after capture; assertions concern the
 * actual system message, not a model's willingness to obey it. Nothing from
 * the user's native configuration, credentials or history is read or logged.
 */
/* oxlint-disable import/max-dependencies, promise/avoid-new -- Native HTTP probe and callback-based server lifecycle. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { UnsupportedOptionError } from "../packages/oar/src/contracts/errors.js";
import type { SessionOptions } from "../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

const BASE = "OAR_BASE_REQUEST_710";
const APPEND = "OAR_APPEND_REQUEST_710";
const CHANGED = "OAR_RESUME_REQUEST_710";
const systems: string[] = [];

async function requestSystem(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  const stream: AsyncIterable<unknown> = request;
  for await (const chunk of stream) {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  let bytes = Buffer.concat(chunks);
  if (request.headers["content-encoding"] === "gzip") { bytes = gunzipSync(bytes); }
  if (request.headers["content-encoding"] === "zstd") { bytes = zstdDecompressSync(bytes); }
  const body = asRecord(JSON.parse(bytes.toString()));
  assert.equal(body?.model, "oar-audit", "only the isolated probe model may be used");
  const { messages } = body;
  assert.ok(Array.isArray(messages), "expected chat-completions request");
  return messages.map((item: unknown) => asRecord(item)).filter((item) => item?.role === "system").map((item) => String(item?.content)).join("\n");
}

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const system = await requestSystem(request);
    systems.push(system);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Controlled probe stop after request capture" } }));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
}
const server = createServer((request, response) => { void respond(request, response); });
await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const endpoint = `http://127.0.0.1:${String(address.port)}/v1`;
const cwd = await mkdtemp(path.join(tmpdir(), "oar-grok-prompts-"));
const nativeHome = path.join(cwd, "native-home");
const command = process.env.OAR_GROK_BIN ?? "grok";
const installation = { kind: "available", via: "executable", command } as const;
const options: SessionOptions = { cwd, model: "oar-audit", env: { GROK_HOME: nativeHome, XAI_API_KEY: "probe-dummy" } };
const profile = { ...grokAcpProfile, args: ["agent", "--always-approve", "--no-leader", "--cli-chat-proxy-base-url", endpoint, "stdio"] };
const current = acpSession(profile);
// Reproduce the vendor's two independent metadata inputs, without OAR's fix.
const raw = acpSession({
  ...profile,
  validateOptions: () => {},
  initializeMeta: (input) => ({
    systemPromptOverride: input.systemPrompt,
    rules: input.appendSystemPrompt,
  }),
});

async function capture(start: typeof current, requested: Partial<SessionOptions>): Promise<{ id: string; system: string }> {
  const session = await start(installation, { ...options, ...requested });
  const offset = systems.length;
  try {
    await promptAndWait(session, "Hello.", { timeoutMs: 20_000 });
    const requests = systems.slice(offset);
    assert.ok(requests.length > 0, "native process did not reach the local provider");
    assert.ok(requests.every((system) => system === requests[0]), "retry changed system instructions");
    const [system] = requests;
    assert.ok(system !== undefined);
    return { id: session.id, system };
  } finally {
    await session.dispose();
  }
}

try {
  await mkdir(nativeHome);
  await writeFile(path.join(nativeHome, "config.toml"), `[cli]
auto_update = false
use_leader = false
[features]
remote_fetch = false
telemetry = false
[telemetry]
trace_upload = false
[models]
default = "oar-audit"
[model.oar-audit]
model = "oar-audit"
base_url = "${endpoint}"
api_key = "probe-dummy"
api_backend = "chat_completions"
context_window = 128000
max_completion_tokens = 100
`);
  const version = await runExecutable(command, ["--version"]);
  assert.equal(version.ok, true, version.stderr);
  console.log(version.stdout.trim());
  const native = await capture(raw, { systemPrompt: BASE, appendSystemPrompt: APPEND });
  assert.equal(native.system, BASE, "native override must reproduce the missing rules");
  const ignored = await capture(raw, { resume: native.id, appendSystemPrompt: CHANGED });
  assert.equal(ignored.system, BASE, "native resume must reproduce ignored rules");
  const combined = await capture(current, { systemPrompt: BASE, appendSystemPrompt: APPEND });
  assert.equal(combined.system, `${BASE}\n\n${APPEND}`, "both options must reach the model in order");
  const resumed = await capture(current, { resume: combined.id, systemPrompt: CHANGED, appendSystemPrompt: APPEND });
  assert.equal(resumed.id, combined.id);
  assert.equal(resumed.system, `${CHANGED}\n\n${APPEND}`);
  const replaced = await capture(current, { resume: combined.id, systemPrompt: BASE });
  assert.equal(replaced.system, BASE, "resume override itself works");
  const appended = await capture(current, { appendSystemPrompt: APPEND });
  assert.ok(appended.system.includes(APPEND) && appended.system.length > APPEND.length, "append-only must retain native instructions");
  await assert.rejects(current(installation, { ...options, resume: combined.id, appendSystemPrompt: CHANGED }), (error: unknown) => error instanceof UnsupportedOptionError && error.option === "appendSystemPrompt");
  console.log("PASS native precedence, native resume rules, combined new/resume, resumed override, new append, refused resume append");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await rm(cwd, { recursive: true, force: true });
}
