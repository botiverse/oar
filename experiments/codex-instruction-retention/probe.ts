/* oxlint-disable no-await-in-loop -- Run isolated controls in order. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { codexThreadOpen } from "../../packages/oar/src/runtimes/codex/open.js";
import { codexVersion } from "../../packages/oar/src/runtimes/codex/refusal.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock, type AimockEnv, type RawProviderRequest } from "../../sea-trial/harness/aimock.js";

const model = "gpt-6.2-sol";
const threadMark = "OAR_THREAD_INSTRUCTION_346";
const modeMark = "OAR_MODE_INSTRUCTION_346";
const contextMark = "OAR_APPLICATION_CONTEXT_346";
const injectedMark = "OAR_INJECTED_MESSAGE_346";
const catalogMark = "<collaboration_mode># Collaboration Mode: Default";
const scenarios = ["manual", "automatic", "manual-remote", "automatic-remote", "catalog", "fallback"] as const;
type Scenario = typeof scenarios[number];

function modelInput(body: unknown): unknown[] {
  const input = asRecord(body)?.input;
  assert.ok(Array.isArray(input));
  return input;
}

interface SelectedRequest {
  path: string;
  thread: unknown[]; mode: unknown[]; catalog: unknown[]; application: unknown[]; injected: unknown[];
  followup: unknown[]; later: unknown[];
  remoteTrigger: boolean; remoteSummary: boolean;
}

function selectRequest({ path, body }: RawProviderRequest): SelectedRequest {
  const input = modelInput(body);
  function roles(mark: string): unknown[] {
    return input.filter(item => {
      const content = asRecord(item)?.content;
      return Array.isArray(content) && content.some(part => {
        const text = asRecord(part)?.text;
        return typeof text === "string" && text.includes(mark);
      });
    }).map(item => asRecord(item)?.role);
  }
  return {
    path, thread: roles(threadMark), mode: roles(modeMark), catalog: roles(catalogMark),
    application: roles(contextMark), injected: roles(injectedMark),
    followup: roles("OAR_FOLLOWUP_346"), later: roles("OAR_LATER_346"),
    remoteTrigger: input.some(item => asRecord(item)?.type === "compaction_trigger"),
    remoteSummary: input.some(item => asRecord(item)?.encrypted_content === "OAR_SYNTHETIC_COMPACTED_346"),
  };
}

// The native remote-v2 protocol requires exactly one compaction output item.
function remoteCompletion(): string {
  const item = { type: "compaction", encrypted_content: "OAR_SYNTHETIC_COMPACTED_346" };
  const usage = { input_tokens: 40, output_tokens: 4, total_tokens: 44 };
  const response = { id: "resp_oar_compacted", status: "completed", usage };
  const events = [{ type: "response.output_item.done", item }, { type: "response.completed", response }];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function provider(scenario: Scenario): Promise<AimockEnv> {
  let compactResponse = false;
  const seedTokens = scenario.startsWith("automatic") ? 110_000 : 32;
  const fixture = await startCodexAimock(mock => {
    mock.onMessage("OAR_seed_346", { content: "First reply.", usage: { input_tokens: seedTokens, output_tokens: 4, total_tokens: seedTokens + 4 } });
    mock.onMessage(/^(?!OAR_seed_346$)[\s\S]*$/u, { content: "Scripted reply.", usage: { input_tokens: 40, output_tokens: 4, total_tokens: 44 } });
  }, {
    captureRaw: true, warmHome: false,
    rewriteRequest(body) {
      compactResponse = modelInput(body).some(item => asRecord(item)?.type === "compaction_trigger");
      return body;
    },
    rewriteResponse: body => compactResponse ? remoteCompletion() : body,
  });
  return fixture;
}

function collaboration(mode: "default" | "plan", instruction: string): JsonRecord {
  return { collaborationMode: { mode, settings: { model, reasoning_effort: null, developer_instructions: instruction } } };
}

function textInput(value: string): JsonRecord[] {
  return [{ type: "text", text: value }];
}

async function configure(home: string, remote: boolean): Promise<void> {
  const config = join(home, "config.toml");
  const existing = await readFile(config, "utf8");
  const remoteConfig = '[model_providers.aimock.capabilities]\nremote_compaction = "v2"\n[features]\nremote_compaction_v2 = true';
  await writeFile(config, ['model_auto_compact_token_limit = 100000', existing, remote ? remoteConfig : ""].join("\n"));
}

// oxlint-disable-next-line max-statements -- Keep the input and the native completion for each turn in the same lifecycle.
async function measure(native: string, scenario: Scenario): Promise<JsonRecord> {
  const remote = scenario.endsWith("-remote");
  const fixture = await provider(scenario);
  const home = fixture.env?.CODEX_HOME;
  assert.ok(home !== undefined);
  const blockedProxy = "http://127.0.0.1:9";
  const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...fixture.env, HOME: home, USERPROFILE: home,
    PATH: process.env.PATH ?? "", HTTP_PROXY: blockedProxy, HTTPS_PROXY: blockedProxy, ALL_PROXY: blockedProxy, NO_PROXY: "localhost,127.0.0.1" };
  await configure(home, remote);
  const client = startAppServerClient(native, env, {}, home);
  const timeout = setTimeout(() => { client.kill(); }, 30_000);
  const compact: { method: string; id: unknown; requestCount: number }[] = [];
  let done = Promise.withResolvers<JsonRecord>();
  client.handle({
    onNotification(method, params) {
      const turn = asRecord(params.turn);
      if (method === "turn/completed" && turn) { done.resolve(turn); }
      const item = asRecord(params.item);
      if (item?.type === "contextCompaction") { compact.push({ method, id: item.id, requestCount: fixture.raw.length }); }
    },
    onServerRequest(id) { client.respond(id, { error: { code: -32_601, message: "No interactive requests in fixture" } }); },
  });
  async function run(method: string, params: JsonRecord): Promise<void> {
    done = Promise.withResolvers<JsonRecord>();
    await client.request(method, params);
    const turn = await Promise.race([done.promise, client.exited.then(() => { throw new Error("Native exited before turn completion"); })]);
    assert.equal(turn.status, "completed", JSON.stringify(turn.error));
  }
  try {
    const init = await client.request("initialize", { clientInfo: { name: "instruction-probe", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const open = codexThreadOpen({ cwd: home, model, appendSystemPrompt: threadMark });
    const reply = await client.request(open.method, open.params);
    const threadId = asRecord(reply.thread)?.id;
    assert.equal(typeof threadId, "string");
    await client.request("thread/inject_items", { threadId, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: injectedMark }] }] });
    await run("turn/start", { threadId, input: textInput("OAR_seed_346"), additionalContext: { fixture: { kind: "application", value: contextMark } },
      ...(scenario === "catalog" ? collaboration("plan", "OAR_SEED_PLAN_346") : {}) });
    if (scenario.startsWith("manual")) { await run("thread/compact/start", { threadId }); }
    const modes: Partial<Record<Scenario, JsonRecord>> = { catalog: collaboration("default", modeMark), fallback: collaboration("plan", modeMark) };
    await run("turn/start", { threadId, input: textInput("OAR_FOLLOWUP_346"), ...modes[scenario] });
    await run("turn/start", { threadId, input: textInput("OAR_LATER_346") });
    const requests = fixture.raw.map(selectRequest);
    const shouldCompact = scenario.startsWith("manual") || scenario.startsWith("automatic");
    assert.deepEqual(compact.map(event => event.method), shouldCompact ? ["item/started", "item/completed"] : []);
    assert.equal(requests.length, shouldCompact ? 4 : 3);
    if (shouldCompact) {
      assert.equal(typeof compact[0]?.id, "string");
      assert.equal(compact[0]?.id, compact[1]?.id);
      assert.equal(compact[1]?.requestCount, 2);
    }
    const seed = requests.at(0);
    assert.ok(seed !== undefined);
    assert.deepEqual(seed.injected, ["developer"]);
    assert.deepEqual(seed.application, ["developer"]);
    assert.equal(requests.some(request => request.remoteTrigger), remote);
    assert.deepEqual(requests.at(-2)?.followup, ["user"]);
    assert.deepEqual(requests.at(-1)?.later, ["user"]);
    for (const request of requests) { assert.deepEqual(request.thread, ["developer"]); }
    for (const request of requests.slice(-2)) {
      assert.equal(request.remoteSummary, remote);
      assert.deepEqual(request.injected, shouldCompact ? [] : ["developer"]);
      assert.deepEqual(request.mode, scenario === "fallback" ? ["developer"] : []);
      if (scenario === "catalog") {
        assert.ok(request.catalog.length > seed.catalog.length);
        assert.ok(request.catalog.every(role => role === "developer"));
      }
    }
    if (process.env.OAR_PROBE_RAW_DIR !== undefined) {
      await writeFile(join(process.env.OAR_PROBE_RAW_DIR, `${scenario}.json`), JSON.stringify({ raw: fixture.raw, compact }, null, 2));
    }
    return { scenario, version: codexVersion(init), compaction: compact.map(({ method, requestCount }) => ({ method, requestCount })), requests };
  } finally {
    clearTimeout(timeout);
    client.kill();
    await client.exited;
    await fixture.stop();
  }
}

const command = process.env.OAR_CODEX_BIN;
assert.ok(command !== undefined, "Set OAR_CODEX_BIN to the native executable under test");
const results = [];
for (const scenario of scenarios) { results.push(await measure(command, scenario)); }
console.log(JSON.stringify(results, null, 2));
