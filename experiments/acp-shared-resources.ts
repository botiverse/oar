/** Native ACP shared-process cohorts, local providers only; no production policy changes.
 * pnpm tsx experiments/acp-shared-resources.ts <output-dir> <runtime> [count...]
 */
/* oxlint-disable eslint/no-await-in-loop -- Cohorts and sampling windows intentionally run serially. */
/* oxlint-disable import/max-dependencies -- The comparison composes the existing native ACP fixtures and profiles. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRuntimes } from "../packages/oar/src/index.js";
import { createAcpClientApp } from "../packages/oar/src/shared/acp/client-app.js";
import { createAcpTerminalHost } from "../packages/oar/src/shared/acp/terminal.js";
import { startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { kimiAcpProfile } from "../packages/oar/src/runtimes/kimi/session.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { opencodeAcpProfile } from "../packages/oar/src/runtimes/opencode/session.js";
import { antigravityAcpProfile } from "../packages/oar/src/runtimes/antigravity/session.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import { forest, isolatedEnvironment, newRoots, processTable, sample, survivors } from "./support/linux-resources.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/acp-shared");
const id = process.argv[3] ?? "kimi";
const counts = process.argv.slice(4).length === 0 ? [1, 5, 10] : process.argv.slice(4).map(Number);
const profiles = { kimi: kimiAcpProfile, grok: grokAcpProfile, opencode: opencodeAcpProfile, antigravity: antigravityAcpProfile };
const factories = { kimi: startKimiAimock, grok: startGrokAimock, opencode: startOpencodeAimock, antigravity: startAntigravityAimock };
assert.ok(id === "kimi" || id === "grok" || id === "opencode" || id === "antigravity");
await mkdir(out, { recursive: true });
const all: Record<string, unknown>[] = [];
for (const count of counts) {
  const home = await mkdtemp(path.join(tmpdir(), "oar-acp-shared-"));
  const provider = await factories[id]((mock) => {
    for (let index = 0; index < count; index += 1) {
      mock.on({ predicate: (request) => request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(`COHORT_${String(index)}_END`)) }, { content: `ANSWER_${String(index)}_END` }, { latency: 80 });
    }
    mock.onMessage(/[\s\S]*/u, { content: "ok" });
  });
  const environment = Object.fromEntries(Object.entries({ ...isolatedEnvironment(home), ...provider.env }).filter((entry): entry is [string, string] => entry[1] !== null));
  const terminal = createAcpTerminalHost(home, environment, { shellCommand: id === "grok" });
  const wire: unknown[] = [];
  const notifications: { method: string; params: JsonRecord }[] = [];
  const app = createAcpClientApp(terminal, { update: (params) => { notifications.push({ method: "session/update", params: { ...params } }); },
    requested: (requestId, method, params) => { wire.push({ requestId, method, params }); }, answered: (requestId, reply) => { wire.push({ requestId, reply }); },
    extension: (method, params) => { notifications.push({ method, params }); }, extensionNotifications: profiles[id].extensionNotifications ?? [] });
  const runtime = defaultRuntimes.require(id);
  const installation = await runtime.installation?.(); assert.ok(installation?.kind === "available" && installation.via === "executable");
  const profile = profiles[id];
  const options = { cwd: home };
  const args = typeof profile.args === "function" ? profile.args(options) : profile.args;
  const before = await processTable();
  const child = startAcpProcess(installation.command, args, app, { cwd: home, env: environment });
  const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
    const result = await withAcpDeadline(child, method, 30_000,  async (opts) => { const reply = await child.connection.agent.request(method, params, opts); return reply; });
    assert.ok(asRecord(result) !== null); wire.push({ method, params, response: result }); return asRecord(result) ?? {};
  };
  const report: Record<string, unknown> = { id, count, version: installation.version, at: new Date().toISOString() };
  let roots = await newRoots(before);
  let observed = roots;
  try {
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: true }, clientInfo: { name: "oar-resource-probe", version: "1" },
      _meta: profile.initializeMeta?.(options) ?? {} });
    roots = await newRoots(before);
    const auth = profile.selectAuthMethod?.(initialized);
    if (auth !== undefined) { await request("authenticate", { methodId: auth }); }
    const cwds = await Promise.all(Array.from({ length: count }, async (_v, index) => { const cwd = path.join(home, `cwd-${String(index)}`); await mkdir(cwd); return cwd; }));
    const opened = await Promise.all(cwds.map(async (cwd) => {
      const response = await request("session/new", { cwd, mcpServers: [], _meta: profile.sessionMeta?.({ cwd }, initialized) ?? {} });
      assert.equal(typeof response.sessionId, "string"); const sessionId = String(response.sessionId);
      await profile.configureSession?.({ request, sessionId, response, options: { cwd } });
      return { sessionId, cwd, response };
    }));
    report.opened = opened;
    assert.equal(new Set(opened.map((entry) => entry.sessionId)).size, count, "distinct native sessions");
    await delay(2000); report.idle = await sample(roots);
    const replies = await Promise.all(opened.map(async (entry, index) => { const reply = await request("session/prompt", { sessionId: entry.sessionId, prompt: [{ type: "text", text: `COHORT_${String(index)}_END` }] }); return reply; }));
    report.replies = replies;
    await delay(2000); report.afterTurn = await sample(roots);
    const messageIsolation = opened.map((entry, index) => {
      const text = notifications.filter((event) => event.params.sessionId === entry.sessionId && asRecord(event.params.update)?.sessionUpdate === "agent_message_chunk")
        .map((event) => { const value = asRecord(asRecord(event.params.update)?.content)?.text; return typeof value === "string" ? value : ""; }).join("");
      return { index, text, matched: text.includes(`ANSWER_${String(index)}_END`) && !opened.some((_other, j) => j !== index && text.includes(`ANSWER_${String(j)}_END`)) };
    });
    report.messageIsolation = messageIsolation;
    assert.ok(messageIsolation.every((entry) => entry.matched), "session-specific answer missing or crossed sessions");
    report.close = await request("session/close", { sessionId: opened[0]?.sessionId }).then((reply) => ({ reply }), (error: unknown) => ({ error: String(error) }));
    report.afterClose = await sample(roots);
    report.outcome = "completed";
  } catch (error) { report.outcome = "failed"; report.error = String(error); }
  finally {
    observed = forest(await processTable(), roots); child.kill(); await child.exited; await terminal.dispose(); await delay(1000);
    report.cleanupSurvivors = await survivors(observed); report.wire = wire; report.notifications = notifications; report.providerRequests = provider.raw;
    await writeFile(path.join(out, `${id}-${String(count)}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await provider.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  all.push(report); process.stdout.write(`${JSON.stringify({ id, count, outcome: report.outcome, error: report.error, messageIsolation: report.messageIsolation })}\n`);
}
await writeFile(path.join(out, "summary.json"), `${JSON.stringify(all, null, 2)}\n`);
assert.ok(all.every((report) => report.outcome === "completed"), "at least one cohort failed; evidence retained");
