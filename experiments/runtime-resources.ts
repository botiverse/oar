/**
 * Linux process costs, using real runtimes and local model substitutes only.
 * Run with OAR_{CODEX,CLAUDE,KIMI,QWEN,QODER}_BIN overrides:
 * pnpm tsx experiments/runtime-resources.ts [output-dir] [runtime...]
 * Each size opens fresh sessions serially. No production process policy changes.
 */
/* oxlint-disable eslint/no-await-in-loop -- Session sizes and measurement stages must run serially to keep process attribution and timing meaningful. */
/* oxlint-disable import/max-dependencies -- This comparative experiment composes five native fixtures and observation helpers. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRuntimes, type Session, type SessionOptions } from "../packages/oar/src/index.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../sea-trial/harness/aimock.js";
import { startKimiAimock, startGrokAimock, startOpencodeAimock, startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";
import { startQwenAimock, isolatedQwenEnvironment } from "../sea-trial/harness/qwen-aimock.js";
import { startQoderNative } from "../sea-trial/harness/qoder-native.js";
import { runTurn } from "../sea-trial/vendor/support/asserts.js";
import { forest, isolatedEnvironment, newRoots, processTable, sample, survivors, type LinuxProcess } from "./support/linux-resources.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/runtime-resources");
await mkdir(out, { recursive: true });
const requested = process.argv.slice(3);
const targets = requested.length === 0 ? ["codex", "claude", "kimi", "qwen", "qoder", "codex-shared"] : requested;
const results: Record<string, unknown>[] = [];
async function publicResources(session: Session): Promise<unknown> {
  if (session.resources === undefined) { return null; }
  const value = await session.resources(); return value;
}

async function fixture(id: string, home: string): Promise<{
  next: () => SessionOptions | Promise<SessionOptions>; stop: () => Promise<void>;
}> {
  const base = isolatedEnvironment(home);
  if (id === "qoder") {
    const native = await startQoderNative(Array.from({ length: 30 }, () => ({ text: "ok" })));
    return { next: () => ({ ...native.options, model: "efficient", env: { ...base, ...native.options.env } }), stop: native.stop };
  }
  if (id === "qwen") {
    const provider = await startQwenAimock();
    return { next: async () => ({ cwd: provider.cwd, model: "gpt-5.1", env: { ...base, ...await isolatedQwenEnvironment(provider) } }), stop: async () => { await provider.stop(); } };
  }
  let provider = null;
  let model = {};
  if (id === "grok") { provider = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 80 }); }); }
  else if (id === "opencode") { provider = await startOpencodeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 80 }); }); }
  else if (id === "antigravity") { provider = await startAntigravityAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 80 }); }); }
  else if (id === "claude") { provider = await startClaudeAimock(); model = { model: "sonnet" }; }
  else if (id === "kimi") {
    provider = await startKimiAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 80 }); });
  } else { provider = await startCodexAimock(undefined, { warmHome: false }); model = { model: "gpt-5.1" }; }
  return { next: () => ({ cwd: home, env: { ...base, ...provider.env }, ...model }), stop: async () => { await provider.stop(); } };
}

async function bounded<T>(work: Promise<T>, ms: number, description: string): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => { timeout.reject(new Error(`Timed out: ${description}`)); }, ms);
  try { return await Promise.race([work, timeout.promise]); }
  finally { clearTimeout(timer); }
}

async function measure(id: string, count: number): Promise<Record<string, unknown>> {
  const home = await mkdtemp(path.join(tmpdir(), "oar-resources-"));
  const runtime = defaultRuntimes.require(id);
  const setup = await fixture(id, home);
  const sessions: Session[] = [];
  const roots: LinuxProcess[] = [];
  const opened: number[] = [];
  const report: Record<string, unknown> = { id, count, at: new Date().toISOString() };
  let observed: LinuxProcess[] = [];
  try {
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available");
    report.version = installation.via === "executable" ? installation.version : null;
    for (let index = 0; index < count; index += 1) {
      const before = await processTable();
      const start = performance.now();
      const session = await runtime.session(installation, await setup.next());
      sessions.push(session);
      opened.push(performance.now() - start);
      roots.push(...await newRoots(before));
    }
    assert.equal(roots.length, count, "one observed direct child root for each OAR session");
    report.openMs = opened;
    await delay(2000);
    report.idle = await sample(roots);
    report.publicIdle = await Promise.all(sessions.map(async (session) => { const value = await publicResources(session); return value; }));
    const turns: unknown[] = [];
    for (const session of sessions) { turns.push(await bounded(runTurn(session, "Say ok."), 30_000, "one simple turn")); }
    report.turns = turns;
    await delay(2000);
    report.afterTurn = await sample(roots);
    report.publicAfterTurn = await Promise.all(sessions.map(async (session) => { const value = await publicResources(session); return value; }));
    report.outcome = "completed";
  } catch (error) {
    report.outcome = "failed";
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    observed = forest(await processTable(), roots);
    await Promise.allSettled(sessions.map(async (session) => { await session.dispose(); }));
    await delay(1000);
    report.survivorsAfterDispose = await survivors(observed);
    await setup.stop();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await writeFile(path.join(out, `${id}-${String(count)}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

async function sharedCodex(): Promise<Record<string, unknown>> {
  const home = await mkdtemp(path.join(tmpdir(), "oar-resources-shared-"));
  const provider = await startCodexAimock(undefined, { warmHome: false });
  const before = await processTable();
  const client = startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", { ...isolatedEnvironment(home), ...provider.env }, { sandbox_mode: '"danger-full-access"' }, home);
  const completed = new Map<string, unknown>();
  client.handle({ onNotification: (method, params) => {
    if (method === "turn/completed" && typeof params.threadId === "string") { completed.set(params.threadId, params.turn); }
  }, onServerRequest: () => {} });
  const report: Record<string, unknown> = { id: "codex-shared", count: 10, at: new Date().toISOString() };
  let roots: LinuxProcess[] = [];
  let observed: LinuxProcess[] = [];
  try {
    await client.request("initialize", { clientInfo: { name: "oar-resource-probe", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    roots = await newRoots(before);
    assert.equal(roots.length, 1);
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const reply = await client.request("thread/start", { cwd: home, model: "gpt-5.1", approvalPolicy: "never" });
      const id = asRecord(reply.thread)?.id;
      assert.equal(typeof id, "string"); ids.push(String(id));
    }
    await delay(2000); report.idle = await sample(roots);
    for (const threadId of ids) {
      await client.request("turn/start", { threadId, input: [{ type: "text", text: "Say ok." }] });
      const deadline = performance.now() + 30_000;
      while (!completed.has(threadId)) { assert.ok(performance.now() < deadline, "shared thread ended"); await delay(20); }
    }
    report.turns = [...completed.values()];
    await delay(2000); report.afterTurn = await sample(roots);
    report.unsubscribe = await client.request("thread/unsubscribe", { threadId: ids[0] });
    report.afterUnsubscribe = await sample(roots);
    await delay(10_000); report.afterUnsubscribeGrace = await sample(roots);
    report.loaded = await client.request("thread/loaded/list", {});
    // Unsubscribe only detaches notifications in 0.165.0; archive removes the loaded thread.
    report.archive = await client.request("thread/archive", { threadId: ids[0] });
    report.afterArchive = await sample(roots);
    report.loadedAfterArchive = await client.request("thread/loaded/list", {});
    report.outcome = "completed";
  } catch (error) { report.outcome = "failed"; report.error = error instanceof Error ? error.message : String(error); }
  finally {
    observed = forest(await processTable(), roots);
    client.kill(); await client.exited; await delay(1000);
    report.survivorsAfterDispose = await survivors(observed);
    await provider.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await writeFile(path.join(out, "codex-shared-10.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

for (const id of targets) {
  if (id === "codex-shared") { results.push(await sharedCodex()); }
  else { for (const count of [1, 5, 10]) { results.push(await measure(id, count)); } }
  process.stdout.write(`${JSON.stringify(results.filter((result) => result.id === id))}\n`);
}
await writeFile(path.join(out, "summary.json"), `${JSON.stringify({ platform: process.platform, architecture: process.arch,
  kernel: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), results }, null, 2)}\n`);
assert.ok(results.every((result) => result.outcome === "completed"), "at least one measurement failed; retained in output directory");
