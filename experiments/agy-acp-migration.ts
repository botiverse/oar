/** Native agy ACP migration controls, with isolated homes and a local Gemini provider. */
/* oxlint-disable eslint/no-await-in-loop, typescript/promise-function-async, unicorn/prefer-single-call -- Ordered native protocol observations. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline, type AcpProcess } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, asRecordList, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock, type AcpAimockEnv } from "../sea-trial/harness/aimock-acp.js";
import { ECHO_SERVER, startHttpEcho } from "../sea-trial/vendor/support/echo-mcp.js";

const configuredBinary = process.env.OAR_AGY_BIN;
assert.ok(configuredBinary !== undefined && path.isAbsolute(configuredBinary), "Set OAR_AGY_BIN to an absolute agy CLI path");
const binary: string = configuredBinary;
const output = path.resolve(process.env.OAR_PROBE_DIR ?? "oar-trial-run/agy-acp-migration");
await mkdir(output, { recursive: true });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SystemRoot"].includes(key)));
const evidence: unknown[] = [];
const homes = new Set<string>();
const args = ["acp", "--disable-telemetry", "--dangerously-skip-permissions", ...(process.env.OAR_PROBE_WORKERS === "0" ? [] : ["--process-per-session"])];

interface NativeRun {
  readonly native: AcpProcess;
  readonly request: (method: string, params: JsonRecord) => Promise<JsonRecord>;
  readonly initialized: JsonRecord;
  readonly home: string;
  readonly stop: () => Promise<void>;
}

async function launch(fixture: AcpAimockEnv, wire: unknown[], processCwd?: string): Promise<NativeRun> {
  const home = fixture.env.HOME;
  assert.ok(home !== undefined);
  homes.add(home);
  const settings = path.join(home, ".gemini", "antigravity-cli");
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, "settings.json"), JSON.stringify({ modelProvider: "gemini", setupComplete: true, onboardingComplete: true }));
  const native = startAcpProcess(binary, args, createAcpClient({ name: "oar" })
    .onNotification(methods.client.session.update, () => {}), {
    cwd: processCwd ?? home, env: { ...inherited, ...fixture.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    incoming: (message) => { wire.push({ direction: "in", at: Date.now(), message }); return message; },
    outgoing: (message) => { wire.push({ direction: "out", at: Date.now(), message }); },
  });
  const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(native, method, 30_000, (options) => native.connection.agent.request(method, params, options))) ?? {};
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar", version: "0.0.0" } });
  return { native, request, initialized, home, stop: async (): Promise<void> => { native.kill(); await native.exited; } };
}

async function steering(): Promise<void> {
  const wire: unknown[] = [];
  const requests: unknown[] = [];
  const seen = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await startAntigravityAimock((mock) => {
    mock.on({ predicate: () => true }, async (request) => {
      requests.push(request);
      assert.ok(requests.length < 20, "Unexpected repeated native model requests");
      const body = JSON.stringify(request.messages);
      if (body.includes("You are a conversation title generator")) { return { content: "probe" }; }
      if (body.includes("echo:steer-result")) { return { content: "STEER_LOOP_DONE" }; }
      seen.resolve();
      await release.promise;
      return { toolCalls: [{ id: "echo-call", name: "mcp_echo_echo", arguments: JSON.stringify({ text: "steer-result", toolSummary: "Echo a probe marker" }) }] };
    });
  });
  const run = await launch(fixture, wire);
  const timer = setTimeout(() => { seen.resolve(); release.resolve(); run.native.kill(); }, 45_000);
  const outcomes: unknown[] = [];
  try {
    const opened = await run.request("session/new", { cwd: run.home, mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER], env: [] }] });
    const prompt = async (text: string): Promise<JsonRecord> => {
      const response = await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text }] });
      outcomes.push({ text, response, at: Date.now() }); return response;
    };
    const first = prompt("INITIAL_STEER_LOOP");
    // oxlint-disable-next-line promise/prefer-await-to-then -- An early native refusal must not be unhandled while awaiting the model barrier.
    void first.catch(() => {});
    await seen.promise;
    const second = prompt("STEER_INSIDE_LOOP");
    // oxlint-disable-next-line promise/prefer-await-to-then -- Observe early native steering replies.
    void second.catch(() => {});
    await delay(100);
    const beforeRelease = [...outcomes];
    release.resolve();
    await Promise.all([first, second]);
    evidence.push({ scenario: "steer", initialized: run.initialized, beforeRelease, outcomes, requests, raw: fixture.raw, wire });
  } finally {
    clearTimeout(timer); release.resolve();
    await writeFile(path.join(output, "steer-provider.json"), JSON.stringify({ requests, raw: fixture.raw, outcomes, diagnostics: run.native.diagnostics() }, null, 2));
    await run.stop();
    await writeFile(path.join(output, "steer-wire.json"), JSON.stringify(wire, null, 2));
    await fixture.stop();
  }
}

async function scan(directory: string, sentinel: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { matches.push(...await scan(file, sentinel)); }
    else if (entry.isFile()) { const content = await readFile(file); if (content.includes(sentinel)) { matches.push(file); } }
  }
  return matches;
}

async function settingsAndResume(): Promise<void> {
  const wire: unknown[] = [];
  const requests: unknown[] = [];
  const remote = await startHttpEcho();
  const fixture = await startAntigravityAimock((mock) => {
    mock.on({ predicate: () => true }, (request) => {
      requests.push(request);
      assert.ok(requests.length < 20, "Unexpected repeated native model requests");
      const body = JSON.stringify(request.messages);
      if (body.includes("You are a conversation title generator")) { return { content: "probe" }; }
      const last = request.messages.findLast((message) => message.role === "user" && JSON.stringify(message.content).includes("PROBE_"));
      const current = JSON.stringify(last?.content);
      const tail = request.messages.slice(last === undefined ? 0 : request.messages.lastIndexOf(last));
      if (current.includes("PROBE_RESUME") && !tail.some((message) => message.role === "tool")) {
        return { toolCalls: [{ id: "cwd-call", name: "run_command", arguments: JSON.stringify({ CommandLine: "pwd", toolSummary: "Check resumed directory", WaitMsBeforeAsync: 1000 }) }] };
      }
      if (current.includes("PROBE_MCP") && !JSON.stringify(tail).includes("echo:remote-result")) {
        const stdioDone = JSON.stringify(tail).includes("echo:stdio-result");
        return { toolCalls: [{ id: stdioDone ? "remote-call" : "stdio-call", name: stdioDone ? "mcp_remote_echo" : "mcp_echo_echo", arguments: JSON.stringify({ text: stdioDone ? "remote-result" : "stdio-result", toolSummary: "Echo a probe marker" }) }] };
      }
      return { content: "PROBE_DONE" };
    });
  });
  let run = await launch(fixture, wire);
  const extra = path.join(run.home, "extra"); await mkdir(extra);
  const changedExtra = path.join(run.home, "changed-extra"); await mkdir(changedExtra);
  const marker = "OAR_SYNTHETIC_MCP_SENTINEL";
  const mcpServers = [
    { name: "echo", command: process.execPath, args: [ECHO_SERVER], env: [{ name: "OAR_ECHO_TOKEN", value: marker }] },
    { name: "remote", type: "http", url: remote.url, headers: [{ name: "Authorization", value: marker }] },
  ];
  const outcomes: unknown[] = [];
  try {
    const opened = await run.request("session/new", {
      cwd: run.home, additionalDirectories: [extra], mcpServers,
      _meta: { antigravity: { systemPrompt: { append: "APPEND_FRESH" }, disabledTools: ["run_command"] } },
    });
    outcomes.push({ opened, initialized: run.initialized });
    outcomes.push(await run.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: "gemini-3.8-flash" }));
    outcomes.push(await run.request("session/set_config_option", { sessionId: opened.sessionId, configId: "thought_level", value: "low" }));
    outcomes.push(await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_MCP" }] }));
    outcomes.push(await run.request("session/close", { sessionId: opened.sessionId }));
    await run.stop(); run = await launch(fixture, wire);
    outcomes.push(await run.request("session/list", {}));
    outcomes.push(await run.request("session/resume", { sessionId: opened.sessionId, cwd: extra, additionalDirectories: [changedExtra], mcpServers: [], _meta: { antigravity: { systemPrompt: { append: "APPEND_RESUME" } } } }));
    outcomes.push(await run.request("session/set_config_option", { sessionId: opened.sessionId, configId: "thought_level", value: "high" }));
    outcomes.push(await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_RESUME" }] }));
    outcomes.push(await run.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: "gemini-3.8-flash" }));
    outcomes.push(await run.request("session/set_config_option", { sessionId: opened.sessionId, configId: "thought_level", value: "high" }));
    outcomes.push(await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_REAPPLY_MODEL" }] }));
    outcomes.push(await run.request("session/close", { sessionId: opened.sessionId }));
    await run.stop(); run = await launch(fixture, wire);
    outcomes.push(await run.request("session/resume", { sessionId: opened.sessionId, cwd: extra, mcpServers: [] }));
    outcomes.push(await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_OMIT" }] }));
    try { outcomes.push(await run.request("session/resume", { sessionId: "missing-oar-session", cwd: extra, mcpServers: [] })); }
    catch (error) { outcomes.push({ missing: String(error), data: error }); }
    const persisted = await scan(run.home, marker);
    evidence.push({ scenario: "settings-resume", outcomes, requests, raw: fixture.raw, wire, persistedSentinel: persisted.map((file) => path.relative(run.home, file)) });
  } finally {
    await writeFile(path.join(output, "settings-resume-provider.json"), JSON.stringify({ requests, raw: fixture.raw, outcomes, diagnostics: run.native.diagnostics() }, null, 2));
    await run.stop(); await writeFile(path.join(output, "settings-resume-wire.json"), JSON.stringify(wire, null, 2));
    await fixture.stop(); remote.stop();
  }
}

async function userMcp(): Promise<void> {
  const wire: unknown[] = [];
  const requests: unknown[] = [];
  const fixture = await startAntigravityAimock((mock) => {
    mock.on({ predicate: () => true }, (request) => { requests.push(request); return { content: "PROBE_DONE" }; });
  }, { mcpServers: { userecho: { command: process.execPath, args: [ECHO_SERVER] } } });
  const run = await launch(fixture, wire);
  try {
    for (const mcpServers of [[], [{ name: "echo", command: process.execPath, args: [ECHO_SERVER], env: [] }]]) {
      const opened = await run.request("session/new", { cwd: run.home, mcpServers });
      await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_USER_MCP" }] });
      await run.request("session/close", { sessionId: opened.sessionId });
    }
    evidence.push({ scenario: "user-mcp", requests, raw: fixture.raw, wire });
  } finally { await run.stop(); await fixture.stop(); }
}

async function cwdRoots(): Promise<void> {
  const wire: unknown[] = [];
  const requests: unknown[] = [];
  const fixture = await startAntigravityAimock((mock) => {
    mock.on({ predicate: () => true }, (request) => {
      requests.push(request);
      if (JSON.stringify(request.messages).includes("conversation title generator")) { return { content: "probe" }; }
      if (request.messages.some((message) => message.role === "tool")) { return { content: "PROBE_DONE" }; }
      return { toolCalls: [{ id: "cwd", name: "run_command", arguments: JSON.stringify({ CommandLine: "pwd", toolSummary: "Check initial directory", WaitMsBeforeAsync: 1000 }) }] };
    });
  });
  const home = fixture.env.HOME; assert.ok(home !== undefined);
  const cwd = path.join(home, "z-original"); const extra = path.join(home, "a-extra");
  await Promise.all([cwd, extra].map((dir) => mkdir(dir)));
  const run = await launch(fixture, wire, cwd);
  const outcomes: unknown[] = [];
  try {
    for (const additionalDirectories of [[], [extra]]) {
      const opened = await run.request("session/new", { cwd, mcpServers: [], additionalDirectories });
      await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_CWD" }] });
      outcomes.push(await run.request("session/list", {}));
      await run.request("session/close", { sessionId: opened.sessionId });
    }
    evidence.push({ scenario: "cwd-roots", outcomes, requests, raw: fixture.raw, wire });
  } finally { await run.stop(); await fixture.stop(); }
}

/** Session listing omits never-prompted sessions; inspect native resume/load directly. */
async function unpromptedResume(): Promise<void> {
  const wire: unknown[] = [];
  const requests: unknown[] = [];
  const fixture = await startAntigravityAimock(mock => {
    mock.on({ predicate: () => true }, request => {
      requests.push(request);
      assert.ok(requests.length < 12, "Unexpected repeated native requests");
      if (JSON.stringify(request.messages).includes("conversation title generator")) { return { content: "probe" }; }
      if (request.messages.some(message => message.role === "tool")) { return { content: "PROBE_DONE" }; }
      return { toolCalls: [{ id: "cwd", name: "run_command", arguments: JSON.stringify({ CommandLine: "pwd", toolSummary: "Read saved directory", WaitMsBeforeAsync: 1000 }) }] };
    });
  });
  const home = fixture.env.HOME; assert.ok(home !== undefined);
  const cwd = path.join(home, "original"); const other = path.join(home, "other");
  await Promise.all([cwd, other].map(dir => mkdir(dir)));
  let run = await launch(fixture, wire, cwd);
  const outcomes: unknown[] = [];
  try {
    for (const method of ["session/resume", "session/load"]) {
      const opened = await run.request("session/new", { cwd, mcpServers: [] });
      await run.request("session/close", { sessionId: opened.sessionId });
      await run.stop(); run = await launch(fixture, wire, other);
      const listing = await run.request("session/list", {});
      assert.ok(!asRecordList(listing.sessions).some(session => session.sessionId === opened.sessionId), "Control needs a saved unlisted session");
      const resumed = await run.request(method, { sessionId: opened.sessionId, cwd: other, mcpServers: [] });
      outcomes.push({ method, listed: false, resumedKeys: Object.keys(resumed) });
      await run.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "PROBE_UNPROMPTED_RESUME_CWD" }] });
      await run.request("session/close", { sessionId: opened.sessionId });
      const absent = "00000000-0000-4000-8000-000000000099";
      try {
        outcomes.push({ method, missing: await run.request(method, { sessionId: absent, cwd: other, mcpServers: [] }) });
      } catch (error) {
        outcomes.push({ method, missingError: String(error), native: error });
      }
    }
  } finally {
    evidence.push({ scenario: "unprompted-resume", outcomes, requests, raw: fixture.raw, wire });
    await run.stop(); await fixture.stop();
  }
}

/** Select only protocol facts and provider fields needed to reproduce the conclusions. */
function selectedProvider(row: JsonRecord): unknown[] {
  return asRecordList(row.raw).filter((request) => !JSON.stringify(asRecord(request.body)?.systemInstruction).includes("conversation title generator")).map((request) => {
    const body = asRecord(request.body);
    const instruction = asRecordList(asRecord(body?.systemInstruction)?.parts).map((part) => String(part.text)).join("\n");
    const contents = JSON.stringify(body?.contents);
    const functions = asRecordList(body?.tools).flatMap((tool) => asRecordList(tool.functionDeclarations));
    return {
      path: request.path,
      generationConfig: body?.generationConfig,
      appended: ["APPEND_FRESH", "APPEND_RESUME"].filter((marker) => instruction.includes(marker)),
      workspaces: /Active Workspaces:[\s\S]*?Command Working Directory: [^\n]+/u.exec(instruction)?.[0],
      selectedToolNames: functions.map((tool) => tool.name).filter((name) => typeof name === "string" && (name.startsWith("mcp_") || ["run_command", "call_mcp_tool"].includes(name))),
      hasSteerInput: contents.includes("STEER_INSIDE_LOOP"),
      hasSteerToolResult: contents.includes("echo:steer-result"),
    };
  });
}

function selectedResponses(row: JsonRecord): unknown[] {
  const requestsById = new Map<unknown, JsonRecord>();
  const responses: unknown[] = [];
  for (const entry of asRecordList(row.wire)) {
    const message = asRecord(entry.message);
    if (entry.direction === "out" && message?.id !== undefined) { requestsById.set(message.id, message); }
    if (entry.direction === "in" && message?.id !== undefined) {
      const result = asRecord(message.result);
      const request = requestsById.get(message.id);
      const params = asRecord(request?.params);
      const resume = request?.method === "session/resume" || request?.method === "session/load";
      responses.push({
        method: request?.method,
        ...(resume ? { absentIdControl: params?.sessionId === "00000000-0000-4000-8000-000000000099", responseKeys: result === null ? undefined : Object.keys(result), sessionIdMatchesRequest: result === null ? undefined : result.sessionId === params?.sessionId } : {}),
        error: message.error,
        stopReason: result?.stopReason,
        agentInfo: result?.agentInfo,
        agentCapabilities: result?.agentCapabilities,
        configOptions: result?.configOptions === undefined ? undefined : asRecordList(result.configOptions).map((option) => ({ id: option.id, currentValue: option.currentValue })),
        sessions: result?.sessions === undefined ? undefined : asRecordList(result.sessions).map((session) => ({ cwd: session.cwd })),
      });
    }
  }
  return responses;
}

function selected(): string {
  const selection = asRecordList(evidence).map((row) => ({
    scenario: row.scenario, error: row.error,
    beforeRelease: row.beforeRelease,
    persistedSentinel: row.persistedSentinel,
    responses: selectedResponses(row),
    provider: selectedProvider(row),
    toolResults: [...new Set(asRecordList(row.requests).flatMap((request) => asRecordList(request.messages).filter((message) => message.role === "tool").map((message) => String(message.content))))],
  }));
  let text = JSON.stringify({ runtime: "agy CLI", platform: `${process.platform} ${process.arch}`, observations: selection }, null, 2);
  for (const home of homes) { text = text.replaceAll(home, "<home>"); }
  return text.replaceAll(/token=[a-f\d]+/gu, "token=<synthetic>").replaceAll(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/gu, "<session-id>");
}

for (const scenario of [steering, settingsAndResume, userMcp, cwdRoots, unpromptedResume].filter((entry) => process.env.OAR_PROBE_CASE === undefined || entry.name === process.env.OAR_PROBE_CASE)) {
  try { await scenario(); } catch (error) { evidence.push({ scenario: scenario.name, error: String(error) }); }
  await writeFile(path.join(output, "native.json"), JSON.stringify(evidence, null, 2));
}
await writeFile(path.join(output, "selected.json"), selected());
console.log(JSON.stringify(evidence.map((value) => { const row = asRecord(value); return { scenario: row?.scenario, error: row?.error }; }), null, 2));
assert.ok(asRecordList(evidence).every((row) => row.error === undefined), "A native control failed; inspect the retained raw evidence");
