/** Codex 0.165.0 goal boundaries, local provider only.
 * OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/codex-goal-boundaries.ts [output-dir]
 */
/* oxlint-disable eslint/no-await-in-loop -- Each native operation depends on the previous one. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";
import { startAppServerClient, type AppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-goal-boundaries");
await mkdir(out, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), "oar-goal-boundaries-"));
const environment = { ...Object.fromEntries(Object.keys(process.env).map((name) => [name, null])), HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_PROXY: "*" };
const evidence: JsonRecord = { at: new Date().toISOString() };
const calls: unknown[] = [];
const events: { method: string; params: JsonRecord }[] = [];
const clients: AppServerClient[] = [];
let slow = false;
const provider = await startCodexAimock((mock) => {
  mock.on({ predicate: () => slow }, { content: "SLOW_TURN_FINISHED", usage: { input_tokens: 40, output_tokens: 20 } }, { latency: 1500 });
  mock.on({ predicate: () => !slow }, { content: "ORDINARY_REPLY" });
}, { captureRaw: true });
async function until(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 25_000;
  while (!predicate()) { assert.ok(performance.now() < end, "native observation timeout"); await delay(10); }
}
async function request(client: AppServerClient, method: string, params: JsonRecord): Promise<JsonRecord> {
  const timer = setTimeout(() => { client.kill(); }, 25_000);
  try {
    const result = await client.request(method, params);
    calls.push({ method, params, result }); return result;
  } catch (error) {
    calls.push({ method, params, error: String(error), cause: error instanceof Error ? error.cause : undefined }); throw error;
  } finally { clearTimeout(timer); }
}
async function connect(enabled: boolean): Promise<AppServerClient> {
  const client = startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", { ...environment, ...provider.env }, { sandbox_mode: '"danger-full-access"', "features.goals": String(enabled) }, home);
  clients.push(client);
  client.handle({ onNotification: (method, params) => { events.push({ method, params }); }, onServerRequest: () => {} });
  await request(client, "initialize", { clientInfo: { name: "oar-goal-boundaries", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {}); return client;
}
async function open(client: AppServerClient, ephemeral = false): Promise<string> {
  const reply = await request(client, "thread/start", { cwd: home, approvalPolicy: "never", ephemeral });
  const id = asRecord(reply.thread)?.id; assert.equal(typeof id, "string"); return String(id);
}
async function turn(client: AppServerClient, threadId: string): Promise<void> {
  const offset = events.length;
  await request(client, "turn/start", { threadId, input: [{ type: "text", text: "Reply with an ordinary answer" }] });
  await until(() => events.slice(offset).some((event) => event.method === "turn/completed" && event.params.threadId === threadId));
}
async function rejected(client: AppServerClient, method: string, params: JsonRecord): Promise<string> {
  try { await request(client, method, params); }
  catch (error) { return String(error); }
  return assert.fail("expected native rejection");
}
function toolNames(body: unknown): string[] {
  const tools = asRecord(body)?.tools;
  if (!Array.isArray(tools)) { return []; }
  return tools.flatMap((value: unknown) => {
    const tool = asRecord(value);
    const children = Array.isArray(tool?.tools) ? tool.tools : [];
    return [tool, ...children.map((child: unknown) => asRecord(child))].flatMap((item) => typeof item?.name === "string" ? [item.name] : []);
  });
}
try {
  const disabled = await connect(false);
  const disabledId = await open(disabled);
  let offset = provider.raw.length;
  await turn(disabled, disabledId);
  const disabledTools = toolNames(provider.raw[offset]?.body);
  evidence.toolsDisabled = disabledTools;
  evidence.disabled = await rejected(disabled, "thread/goal/get", { threadId: disabledId });
  disabled.kill(); await disabled.exited;

  let enabled = await connect(true);
  const id = await open(enabled);
  evidence.freshRead = await request(enabled, "thread/goal/get", { threadId: id });
  evidence.enabledConfig = await request(enabled, "config/read", {});
  offset = provider.raw.length;
  await turn(enabled, id);
  const enabledTools = toolNames(provider.raw[offset]?.body);
  evidence.toolsEnabledNoGoal = enabledTools;
  evidence.noGoal = await request(enabled, "thread/goal/get", { threadId: id });
  assert.equal(asRecord(evidence.noGoal)?.goal, null);
  for (const name of ["get_goal", "create_goal", "update_goal"]) {
    assert.ok(enabledTools.includes(name));
    assert.ok(!disabledTools.includes(name));
  }
  evidence.ephemeral = await rejected(enabled, "thread/goal/set", { threadId: await open(enabled, true), objective: "temporary", status: "paused", origin: "user" });
  const paused = await request(enabled, "thread/goal/set", { threadId: id, objective: "Persistent paused objective", status: "paused", tokenBudget: 100_000, origin: "user" });
  evidence.rejectedBudget = await rejected(enabled, "thread/goal/set", { threadId: id, tokenBudget: -1, origin: "user" });
  evidence.afterRejectedUpdate = await request(enabled, "thread/goal/get", { threadId: id });
  assert.deepEqual(evidence.afterRejectedUpdate, paused);
  enabled.kill(); await enabled.exited;

  enabled = await connect(true);
  offset = events.length;
  await request(enabled, "thread/resume", { threadId: id, cwd: home, approvalPolicy: "never" });
  await until(() => events.slice(offset).some((event) => event.method === "thread/goal/updated" && event.params.threadId === id));
  evidence.resumeNotifications = events.slice(offset).filter((event) => event.method.startsWith("thread/goal/"));
  evidence.resumed = await request(enabled, "thread/goal/get", { threadId: id });
  assert.equal(asRecord(asRecord(evidence.resumed)?.goal)?.objective, "Persistent paused objective");
  assert.equal(asRecord(asRecord(evidence.resumed)?.goal)?.status, "paused");

  slow = true;
  offset = provider.raw.length;
  const eventOffset = events.length;
  await request(enabled, "thread/goal/set", { threadId: id, status: "active", origin: "user" });
  await until(() => provider.raw.length > offset);
  evidence.pauseDuringTurn = await request(enabled, "thread/goal/set", { threadId: id, status: "paused", origin: "user" });
  evidence.completedAtPause = events.slice(eventOffset).filter((event) => event.method === "turn/completed").length;
  await until(() => events.slice(eventOffset).some((event) => event.method === "turn/completed"));
  await delay(500);
  evidence.turnsAfterPause = events.slice(eventOffset).filter((event) => event.method === "turn/started").length;
  evidence.afterPause = await request(enabled, "thread/goal/get", { threadId: id });
  assert.equal(evidence.completedAtPause, 0, "pause returned while the native turn was running");
  assert.equal(evidence.turnsAfterPause, 1, "no follow-up turn in the observation window");
  assert.equal(asRecord(asRecord(evidence.afterPause)?.goal)?.status, "paused");
  evidence.clear = await request(enabled, "thread/goal/clear", { threadId: id, origin: "user" });
  evidence.outcome = "passed";
} catch (error) { evidence.outcome = "failed"; evidence.error = String(error); }
finally {
  for (const client of clients) { client.kill(); await client.exited; }
  evidence.calls = calls; evidence.events = events; evidence.providerRequests = provider.raw;
  await provider.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10 });
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ outcome: evidence.outcome, error: evidence.error, toolsDisabled: evidence.toolsDisabled, toolsEnabledNoGoal: evidence.toolsEnabledNoGoal, disabled: evidence.disabled, ephemeral: evidence.ephemeral, rejectedBudget: evidence.rejectedBudget, turnsAfterPause: evidence.turnsAfterPause })}\n`);
assert.equal(evidence.outcome, "passed");
