/** Native goal evidence through the existing app-server/stream-json launch paths.
 * Local model substitutes only. Run: pnpm tsx experiments/native-goals.ts codex|claude [output-dir]
 */
/* oxlint-disable eslint/no-await-in-loop -- Native control steps depend on the previous result. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCodexAimock, startClaudeAimock } from "../sea-trial/harness/aimock.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { defaultRuntimes } from "../packages/oar/src/index.js";
import { runTurn } from "../sea-trial/vendor/support/asserts.js";

const kind = process.argv[2] ?? "codex";
assert.ok(kind === "codex" || kind === "claude");
const out = path.resolve(process.argv[3] ?? `oar-trial-run/native-goals-${kind}`);
await mkdir(out, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), "oar-native-goal-"));
const isolated = Object.fromEntries(Object.keys(process.env).map((name) => [name, null]));
const environment = { ...isolated, HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NO_PROXY: "*" };
const evidence: Record<string, unknown> = { kind, at: new Date().toISOString() };
async function bounded<T>(work: Promise<T>, ms = 25_000): Promise<T> {
  const limit = Promise.withResolvers<T>();
  const timer = setTimeout(() => { limit.reject(new Error("native goal probe timed out")); }, ms);
  try { return await Promise.race([work, limit.promise]); } finally { clearTimeout(timer); }
}
async function until(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 25_000;
  while (!predicate()) {
    assert.ok(performance.now() < end, "native goal notification arrived within the observation window");
    await delay(20);
  }
}
if (kind === "codex") {
  let active = false;
  let budgetProbe = false;
  const provider = await startCodexAimock((mock) => {
    mock.on({ predicate: () => budgetProbe }, { content: "BUDGET_WORK", usage: { input_tokens: 40, output_tokens: 20 } });
    mock.on({ predicate: (request) => request.messages.at(-1)?.tool_call_id === "goal-completed" }, { content: "GOAL_FINISHED" });
    mock.on({ predicate: (request) => active && JSON.stringify(request.messages).includes("WORK_ROUND_ONE") }, {
      toolCalls: [{ id: "goal-completed", name: "update_goal", arguments: '{"status":"complete"}' }],
    });
    mock.on({ predicate: () => active }, { content: "WORK_ROUND_ONE", usage: { input_tokens: 40, output_tokens: 20 } });
    mock.onMessage(/[\s\S]*/u, { content: "SEEDED" });
  }, { captureRaw: true });
  const client = startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", { ...environment, ...provider.env },
    { sandbox_mode: '"danger-full-access"', "features.goals": "true" }, home);
  const events: unknown[] = [];
  const calls: unknown[] = [];
  let ended = 0;
  client.handle({ onNotification: (method, params) => { events.push({ method, params }); if (method === "turn/completed") { ended += 1; } }, onServerRequest: () => {} });
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { const result = await bounded(client.request(method, params)); calls.push({ method, params, result }); return result; }
    catch (error) { calls.push({ method, params, error: String(error) }); throw error; }
  };
  try {
    await request("initialize", { clientInfo: { name: "oar-goal-probe", version: "1" }, capabilities: { experimentalApi: true } }); client.notify("initialized", {});
    const opened = await request("thread/start", { cwd: home, approvalPolicy: "never" });
    const threadId = asRecord(opened.thread)?.id; assert.equal(typeof threadId, "string");
    await request("turn/start", { threadId, input: [{ type: "text", text: "Seed a persistent test thread" }] });
    await until(() => ended >= 1);
    await request("thread/goal/set", { threadId, objective: "Finish the local test on the next automatic continuation", status: "paused", tokenBudget: 100_000, origin: "user" });
    evidence.paused = await request("thread/goal/get", { threadId });
    await delay(300); evidence.turnsWhilePaused = ended;
    assert.equal(asRecord(asRecord(evidence.paused)?.goal)?.status, "paused");
    assert.equal(ended, 1, "a paused goal did not start another turn during this window");
    active = true;
    await request("thread/goal/set", { threadId, status: "active", origin: "user" });
    await until(() => ended >= 3);
    evidence.completed = await request("thread/goal/get", { threadId });
    evidence.clear = await request("thread/goal/clear", { threadId, origin: "user" });
    evidence.cleared = await request("thread/goal/get", { threadId });
    evidence.clearAgain = await request("thread/goal/clear", { threadId, origin: "user" });
    assert.equal(asRecord(asRecord(evidence.completed)?.goal)?.status, "complete");
    assert.equal(asRecord(evidence.cleared)?.goal, null);
    assert.equal(asRecord(evidence.clear)?.cleared, true);
    assert.equal(asRecord(evidence.clearAgain)?.cleared, false);
    budgetProbe = true;
    await request("thread/goal/set", { threadId, objective: "Budget-bound local test", status: "active", tokenBudget: 1, origin: "user" });
    await until(() => events.some((event) => asRecord(asRecord(asRecord(event)?.params)?.goal)?.status === "budgetLimited"));
    evidence.budgetLimited = await request("thread/goal/get", { threadId });
    assert.equal(asRecord(asRecord(evidence.budgetLimited)?.goal)?.status, "budgetLimited");
    assert.equal(asRecord(asRecord(evidence.budgetLimited)?.goal)?.tokensUsed, 60);
    await request("thread/goal/clear", { threadId, origin: "user" });
    evidence.outcome = "completed";
  } catch (error) { evidence.outcome = "failed"; evidence.error = String(error); }
  finally {
    client.kill(); await client.exited;
    evidence.events = events; evidence.calls = calls; evidence.providerRequests = provider.raw;
    await provider.stop();
  }
} else {
  let evaluations = 0;
  let modelCalls = 0;
  const provider = await startClaudeAimock((mock) => {
    mock.on({ predicate: (request) => request.model.includes("haiku") }, () => {
      evaluations += 1;
      return { content: JSON.stringify({ ok: evaluations >= 2, reason: evaluations >= 2 ? "Goal met" : "CONTINUE_MARKER" }) };
    });
    mock.onMessage(/[\s\S]*/u, () => { modelCalls += 1; return { content: modelCalls === 1 ? "WORK_ROUND_ONE" : "GOAL_FINISHED" }; });
  }, { captureRaw: true });
  const runtime = defaultRuntimes.require("claude");
  const installation = await runtime.installation?.(); assert.ok(installation?.kind === "available");
  const session = await runtime.session(installation, { cwd: home, model: "sonnet", env: { ...environment, ...provider.env, ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  try {
    evidence.goalTurn = await bounded(runTurn(session, "/goal Reply with GOAL_FINISHED after WORK_ROUND_ONE"));
    evidence.statusTurn = await bounded(runTurn(session, "/goal"));
    evidence.clearTurn = await bounded(runTurn(session, "/goal clear"));
    assert.equal(evaluations, 2, "the native Stop evaluator ran before continuing and before finishing");
    assert.equal(modelCalls, 2, "the native goal caused another model request without another host prompt");
    evidence.outcome = "completed";
  } catch (error) { evidence.outcome = "failed"; evidence.error = String(error); }
  finally {
    evidence.evaluations = evaluations; evidence.modelCalls = modelCalls;
    evidence.records = session.records(); evidence.providerRequests = provider.raw;
    await session.dispose(); await provider.stop();
  }
}
await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.stdout.write(`${JSON.stringify({ kind, outcome: evidence.outcome, error: evidence.error, evaluations: evidence.evaluations })}\n`);
assert.equal(evidence.outcome, "completed");
