/**
 * Native OpenCode + OAR -> local provider, without login or model quota.
 * Run: OAR_OPENCODE_BIN=/path/to/opencode pnpm tsx experiments/opencode-prompt-options.ts
 *
 * Observed 2026-10-07, 1.18.34: inline agent.prompt replaces the actual
 * agent's base prompt; instructions append after existing files. Resuming
 * uses the saved agent even when default_agent has changed. Model, tool
 * permissions, original configuration bytes and session identity survive.
 * Literal {env:...}/{file:...} in prompt text must not be interpolated.
 * All native configuration/data/cache and instruction files are disposable.
 */
/* oxlint-disable import/max-dependencies, promise/avoid-new -- Native process/HTTP/file probe, callback-based server lifecycle. */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnsupportedOptionError } from "../packages/oar/src/contracts/errors.js";
import type { SessionOptions } from "../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import { opencodeSession } from "../packages/oar/src/runtimes/opencode/session.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";

const BASE = "OAR_SCRIBE_BASE";
const APPEND = "OAR_APPENDED_INSTRUCTION";
const PRIOR = "OAR_EXISTING_INSTRUCTION";
const REPLACE = "OAR_REPLACED {env:OAR_PROBE_SECRET} {file:no-such-secret-file}";
const requests: JsonRecord[] = [];

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    const stream: AsyncIterable<unknown> = request;
    for await (const chunk of stream) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks.push(chunk);
    }
    const body = asRecord(JSON.parse(Buffer.concat(chunks).toString()));
    assert.ok(body !== null);
    requests.push(body);
    const message = { role: "assistant", content: "PROBE_OK" };
    const usage = { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 };
    const common = { id: "probe", created: 0, model: "audit" };
    if (body.stream === true) {
      const frames = [
        { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: message, finish_reason: null }] },
        { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`);
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }], usage }));
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
}
const server = createServer((request, response) => { void respond(request, response); });
await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const scratch = await mkdtemp(path.join(tmpdir(), "oar-opencode-prompts-"));
const cwd = path.join(scratch, "project");
const configHome = path.join(scratch, "config");
const configFile = path.join(configHome, "opencode", "opencode.json");
const command = process.env.OAR_OPENCODE_BIN ?? "opencode";
const installation = { kind: "available", via: "executable", command } as const;
const env = {
  XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(scratch, "data"),
  XDG_STATE_HOME: path.join(scratch, "state"), XDG_CACHE_HOME: path.join(scratch, "cache"),
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OAR_PROBE_SECRET: "MUST_NOT_EXPAND",
};
const config = {
  $schema: "https://opencode.ai/config.json",
  model: "oar-audit/audit", default_agent: "scribe",
  agent: {
    scribe: { mode: "primary", prompt: BASE, permission: { edit: "deny" } },
    build: { prompt: "OAR_CUSTOM_BUILD", permission: { edit: "deny" } },
  },
  instructions: [path.join(scratch, "prior.md")],
  provider: { "oar-audit": {
    npm: "@ai-sdk/openai-compatible", name: "oar-audit",
    options: { baseURL: `http://127.0.0.1:${String(address.port)}/v1`, apiKey: "probe-dummy" },
    models: { audit: { name: "audit", limit: { context: 128_000, output: 4096 } } },
  } },
};

async function capture(requested: Partial<SessionOptions>): Promise<{ id: string; system: string; tools: string[] }> {
  const before = await readFile(configFile, "utf8");
  const session = await opencodeSession(installation, { cwd, env, ...requested });
  const offset = requests.length;
  let system = "";
  try {
    const turn = await promptAndWait(session, "Say PROBE_OK. Do not use tools.", { timeoutMs: 30_000 });
    assert.ok(turn.kind === "ended");
    assert.equal(turn.outcome.kind, "completed");
    const main = requests.slice(offset).find((body) => Array.isArray(body.tools) && body.tools.length > 0);
    assert.ok(main !== undefined, "main model request not captured");
    assert.equal(main.model, "audit");
    assert.ok(Array.isArray(main.messages) && Array.isArray(main.tools));
    system = main.messages.map((message: unknown) => asRecord(message)).filter((message) => message?.role === "system").map((message) => String(message?.content)).join("\n");
    const tools = main.tools.map((tool: unknown) => asRecord(asRecord(tool)?.function)?.name).filter((name): name is string => typeof name === "string").toSorted();
    assert.ok(!tools.includes("edit") && !tools.includes("write"), "configured edit denial must remain in force");
    assert.equal(await readFile(configFile, "utf8"), before, "native configuration changed");
    return { id: session.id, system, tools };
  } finally {
    await session.dispose();
    const temporary = [...system.matchAll(/^Instructions from: (?<file>.+oar-opencode-prompt-.+\/instructions\.md)$/gmu)].map((match) => match.groups?.file);
    for (const file of temporary) {
      assert.ok(file !== undefined);
      // oxlint-disable-next-line no-await-in-loop -- assert each session-owned file was removed.
      await assert.rejects(access(file), { code: "ENOENT" });
    }
  }
}

try {
  await mkdir(cwd);
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(config.instructions[0] ?? "", PRIOR);
  const version = await runExecutable(command, ["--version"]);
  assert.ok(version.ok, version.stderr);
  console.log(version.stdout.trim());
  const baseline = await capture({});
  assert.ok(baseline.system.includes(BASE) && baseline.system.includes(PRIOR));
  const replaced = await capture({ systemPrompt: REPLACE });
  assert.ok(replaced.system.includes(REPLACE) && !replaced.system.includes(BASE));
  assert.ok(!replaced.system.includes("MUST_NOT_EXPAND"));
  assert.deepEqual(replaced.tools, baseline.tools);
  const appended = await capture({ appendSystemPrompt: APPEND });
  assert.ok(appended.system.includes(BASE));
  assert.ok(appended.system.includes(PRIOR) && appended.system.indexOf(APPEND) > appended.system.indexOf(PRIOR));
  assert.deepEqual(appended.tools, baseline.tools);
  config.default_agent = "build";
  await writeFile(configFile, JSON.stringify(config));
  const resumed = await capture({ resume: baseline.id, systemPrompt: REPLACE, appendSystemPrompt: APPEND });
  assert.equal(resumed.id, baseline.id);
  assert.ok(resumed.system.includes(REPLACE) && resumed.system.includes(APPEND) && !resumed.system.includes("OAR_CUSTOM_BUILD"));
  assert.ok(resumed.system.indexOf(PRIOR) < resumed.system.indexOf(APPEND));
  assert.deepEqual(resumed.tools, baseline.tools);
  const build = await capture({ systemPrompt: REPLACE });
  assert.ok(build.system.includes(REPLACE) && !build.system.includes("OAR_CUSTOM_BUILD"));
  assert.deepEqual(build.tools, baseline.tools);
  await assert.rejects(opencodeSession(installation, { cwd, env: { ...env, OPENCODE_CONFIG_CONTENT: "{}" }, systemPrompt: REPLACE }), (error: unknown) => error instanceof UnsupportedOptionError && error.option === "systemPrompt");
  await writeFile(configFile, JSON.stringify({ ...config, agent: { build: config.agent.build } }));
  await assert.rejects(opencodeSession(installation, { cwd, env, resume: baseline.id, systemPrompt: REPLACE }), (error: unknown) => error instanceof UnsupportedOptionError && error.option === "systemPrompt");
  console.log("PASS removed-agent refusal, custom default/build overrides, append order, saved-agent resume, literal text, model/tool permissions, unchanged config, cleanup and conflict refusal");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await rm(scratch, { recursive: true, force: true });
}
