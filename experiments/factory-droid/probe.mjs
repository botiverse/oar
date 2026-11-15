// oxlint-disable -- Standalone probe of droid's native stream-jsonrpc, run by hand: node experiments/factory-droid/probe.mjs [droid]
// Each scenario runs real `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
// in a fresh HOME whose only model is a custom (BYOK) model served by aimock. No Factory login, no key.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";

const DROID = process.argv[2] ?? "droid";
const MODEL = "custom:Probe-0";

function home(url) {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-droid-probe-"));
  mkdirSync(path.join(dir, ".factory")); mkdirSync(path.join(dir, "cwd"));
  writeFileSync(path.join(dir, ".factory", "settings.json"), JSON.stringify({ customModels: [{ model: "probe-model", displayName: "Probe", baseUrl: `${url}/v1`, apiKey: "probe", provider: "generic-chat-completion-api", maxOutputTokens: 4096 }] }));
  return dir;
}

function droid(dir) {
  const env = { ...process.env, HOME: dir, USERPROFILE: dir }; delete env.FACTORY_API_KEY;
  const child = spawn(DROID, ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], { env, cwd: path.join(dir, "cwd"), stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); const listeners = []; const seen = [];
  let buffer = "";
  child.stdout.on("data", (data) => {
    buffer += data; let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === "response") { pending.get(message.id)?.(message); pending.delete(message.id); continue; }
      const type = message.params?.notification?.type ?? message.method;
      seen.push({ type, message });
      for (const listener of listeners) listener(message, type);
    }
  });
  child.stderr.resume();
  const exited = new Promise((resolve) => { child.on("exit", resolve); });
  return {
    seen,
    request: (method, params = {}, id = randomUUID()) => new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", type: "request", factoryApiVersion: "1.0.0", id, method, params })}\n`); }),
    respond: (id, result) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", type: "response", factoryApiVersion: "1.0.0", id, result })}\n`); },
    on: (listener) => { listeners.push(listener); },
    until: (predicate, ms = 60_000) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout")), ms); listeners.push((message, type) => { if (predicate(message, type)) { clearTimeout(timer); resolve(message); } }); }),
    close: async () => { child.stdin.end(); await exited; },
  };
}

const turnEnd = (turnId) => (message, type) => type === "agent_turn_completed" && (turnId === undefined || message.params.notification.turnId === turnId);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const results = {};

async function scenario(name, configure, run) {
  const mock = new LLMock({ port: 0 }); configure(mock); await mock.start();
  const dir = home(mock.url);
  try { results[name] = await run(dir, mock); }
  catch (error) { results[name] = { error: String(error) }; }
  finally { await mock.stop(); rmSync(dir, { recursive: true, force: true }); }
}

await scenario("steer", (mock) => {
  mock.onMessage(/SLOW/u, { content: "first" }, { latency: 3000 });
  mock.onMessage(/^(?![\s\S]*SLOW)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
}, async (dir, mock) => {
  const d = droid(dir);
  await d.request("droid.initialize_session", { machineId: "default", cwd: path.join(dir, "cwd"), modelId: MODEL, skipPermissionsUnsafe: true });
  const first = randomUUID(); const second = randomUUID();
  const reply = await d.request("droid.add_user_message", { text: "SLOW first", messageId: first });
  await sleep(1200);
  await d.request("droid.add_user_message", { text: "steer second", messageId: second });
  const end = await d.until(turnEnd());
  await sleep(1500);
  await d.close();
  const ends = d.seen.filter((entry) => entry.type === "agent_turn_completed").map((entry) => entry.message.params.notification.turnId);
  return {
    addUserMessageReply: reply.result,
    turnEnds: ends.map((id) => (id === first ? "first" : id === second ? "second" : id)),
    steerQueuedAs: d.seen.find((entry) => entry.type === "queued_messages_changed" && entry.message.params.notification.messages.length > 0)?.message.params.notification.messages[0].queuePlacement,
    steerEchoed: d.seen.some((entry) => entry.type === "create_message" && entry.message.params.notification.message.id === second),
    lastProviderRequestHasSteer: JSON.stringify(mock.getRequests().at(-1)?.body).includes("steer second"),
    endReason: end.params.notification.reason,
  };
});

await scenario("interrupt", (mock) => { mock.onMessage(/[\s\S]*/u, { content: "late" }, { latency: 6000 }); }, async (dir) => {
  const d = droid(dir);
  await d.request("droid.initialize_session", { machineId: "default", cwd: path.join(dir, "cwd"), modelId: MODEL, skipPermissionsUnsafe: true });
  await d.request("droid.add_user_message", { text: "slow", messageId: randomUUID() });
  await sleep(1200);
  const steerRpc = randomUUID();
  await d.request("droid.add_user_message", { text: "queued", messageId: randomUUID() }, steerRpc);
  const interrupt = await d.request("droid.interrupt_session", {});
  const end = await d.until(turnEnd());
  await d.close();
  const discarded = d.seen.find((entry) => entry.type === "queued_messages_discarded")?.message.params.notification;
  return { interruptReply: interrupt.result, endReason: end.params.notification.reason, discardedNamesSteerRpcId: discarded?.drainedRequestIds?.includes(steerRpc) ?? false };
});

await scenario("resume", (mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 50 }); }, async (dir) => {
  let d = droid(dir);
  const opened = await d.request("droid.initialize_session", { machineId: "default", cwd: path.join(dir, "cwd"), modelId: MODEL, skipPermissionsUnsafe: true });
  const turn = randomUUID();
  await d.request("droid.add_user_message", { text: "remember me", messageId: turn });
  await d.until(turnEnd(turn));
  await d.close();
  d = droid(dir);
  const loaded = await d.request("droid.load_session", { sessionId: opened.result.sessionId, messageLimit: 1 });
  const again = randomUUID();
  await d.request("droid.add_user_message", { text: "after resume", messageId: again });
  const end = await d.until(turnEnd(again));
  const missing = await d.request("droid.load_session", { sessionId: randomUUID() });
  await d.close();
  return { loadedKeys: Object.keys(loaded.result ?? {}).sort(), loadedCwdMatches: loaded.result?.cwd === path.join(dir, "cwd"), turnAfterResume: end.params.notification.reason, unknownSessionError: missing.error };
});

await scenario("permissions", (mock) => {
  mock.onMessage(/RUN/u, { toolCalls: [{ name: "Execute", arguments: JSON.stringify({ command: "echo probe-ran", riskLevel: "high", riskLevelReason: "probe" }) }] }, { latency: 50 });
  mock.onToolResult(/[\s\S]*/u, { content: "done" });
}, async (dir) => {
  const outcome = {};
  for (const mode of ["default", "skipPermissionsUnsafe"]) {
    const d = droid(dir);
    const requests = [];
    d.on((message) => { if (message.type === "request") { requests.push({ method: message.method, options: message.params.options?.map((option) => option.value) }); d.respond(message.id, { selectedOption: "proceed_once" }); } });
    const opened = await d.request("droid.initialize_session", { machineId: "default", cwd: path.join(dir, "cwd"), modelId: MODEL, ...(mode === "default" ? {} : { skipPermissionsUnsafe: true }) });
    await d.request("droid.add_user_message", { text: "RUN", messageId: randomUUID() });
    await d.until((message, type) => type === "tool_result");
    await d.close();
    outcome[mode] = { autonomyLevel: opened.result.settings.autonomyLevel, permissionRequests: requests.slice(0, 1) };
  }
  return outcome;
});

await scenario("models-and-effort", () => {}, async (dir) => {
  const d = droid(dir);
  const listed = await d.request("droid.list_models", {});
  const clamped = await d.request("droid.initialize_session", { machineId: "default", cwd: path.join(dir, "cwd"), modelId: MODEL, reasoningEffort: "high" });
  await d.close();
  const e = droid(dir);
  const unknown = await e.request("droid.initialize_session", { machineId: "default", cwd: path.join(dir, "cwd"), modelId: "no-such-model" });
  const context = await e.request("droid.get_context_stats", {});
  await e.close();
  return { listedBeforeSession: listed.result.models.length > 0, customListed: listed.result.models.some((model) => model.id === MODEL),
    requestedHighOnNoneOnlyModelReported: clamped.result.settings.reasoningEffort, unknownModelReported: unknown.result.settings.modelId, contextStatsKeys: Object.keys(context.result ?? {}).sort() };
});

console.log(JSON.stringify(results, null, 2));
