/**
 * Native Grok ACP -> local model request probe. No login or model quota.
 * Run: OAR_GROK_BIN=/path/to/grok pnpm tsx experiments/grok-prompt-options.ts
 *
 * Observed 2026-10-13, 1.0.52 (0920c8169e27): native override and rules
 * both reach the provider on creation and resume. An append-only change on
 * resume is still ignored, so OAR refuses it. Earlier 1.0.46 and 1.0.50
 * ignored rules even alongside an override; the old combined override is
 * no longer needed on 1.0.52. Blank replacements are ignored natively and
 * are refused by OAR, with or without an append.
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
// Bypass OAR's conditional refusal to measure native append-only resume.
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
  assert.equal(native.system, `${BASE}\n\n<human_rules>\n${APPEND}\n</human_rules>`, "native override and rules must both reach the provider");
  const defaults = await capture(raw, {});
  // oxlint-disable eslint/no-await-in-loop -- Captures share a request journal and saved native session; serialize them.
  for (const systemPrompt of ["", " \t\n"]) {
    const blank = await capture(raw, { systemPrompt });
    assert.equal(blank.system, defaults.system, "blank replacement retains native instructions");
    const blankBoth = await capture(raw, { systemPrompt, appendSystemPrompt: APPEND });
    assert.equal(blankBoth.system, `${defaults.system}\n\n<human_rules>\n${APPEND}\n</human_rules>`);
    const blankResume = await capture(raw, { resume: native.id, systemPrompt, appendSystemPrompt: CHANGED });
    assert.equal(blankResume.system, native.system, "blank replacement on resume leaves saved instructions unchanged");
    for (const resume of [undefined, native.id]) {
      for (const appendSystemPrompt of [undefined, APPEND]) {
        await assert.rejects(current(installation, { ...options, systemPrompt,
          ...(resume === undefined ? {} : { resume }),
          ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
        }), (error: unknown) => error instanceof UnsupportedOptionError && error.option === "systemPrompt");
      }
    }
  }
  // oxlint-enable eslint/no-await-in-loop
  const ignored = await capture(raw, { resume: native.id, appendSystemPrompt: CHANGED });
  assert.equal(ignored.system, native.system, "native resume still ignores append-only changes");
  const combined = await capture(current, { systemPrompt: BASE, appendSystemPrompt: APPEND });
  assert.equal(combined.system, native.system, "OAR must preserve the native instruction channels");
  const resumed = await capture(current, { resume: combined.id, systemPrompt: CHANGED, appendSystemPrompt: `${APPEND}_CHANGED` });
  assert.equal(resumed.id, combined.id);
  assert.equal(resumed.system, `${CHANGED}\n\n<human_rules>\n${APPEND}_CHANGED\n</human_rules>`);
  const omitted = await capture(current, { resume: combined.id });
  assert.equal(omitted.system, resumed.system, "omitting instructions retains both saved values");
  const replaced = await capture(current, { resume: combined.id, systemPrompt: BASE });
  assert.equal(replaced.system, BASE, "resume override itself works");
  const appended = await capture(current, { appendSystemPrompt: APPEND });
  assert.ok(appended.system.includes(APPEND) && appended.system.length > APPEND.length, "append-only must retain native instructions");
  await assert.rejects(current(installation, { ...options, resume: combined.id, appendSystemPrompt: CHANGED }), (error: unknown) => error instanceof UnsupportedOptionError && error.option === "appendSystemPrompt");
  console.log("PASS native channels on new/resume, saved instructions, resumed override, new append, refused resume append and blank replacements");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await rm(cwd, { recursive: true, force: true });
}
