/** Codex shared-process gates, native protocol with a local model substitute.
 * OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/codex.ts [output-dir]
 * Does not archive threads or enable OAR sharing. Detailed output stays private.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { codexFixture, type CodexFixture } from "./codex-fixture.js";
import { identities, running } from "./processes.js";
import { ProbeTiming, cwdEvidence, prepareFixture } from "./observation.js";

function tools(fixture: CodexFixture, key: string): string {
  return fixture.seen.filter((entry) => entry.key === key).flatMap((entry) => {
    const messages = asRecord(entry.request)?.messages;
    const rows: readonly unknown[] = Array.isArray(messages) ? messages : [];
    return rows.filter((message: unknown) => asRecord(message)?.role === "tool");
  }).map((message: unknown) => typeof asRecord(message)?.content === "string" ? asRecord(message)?.content : JSON.stringify(asRecord(message)?.content)).join("\n");
}
const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-sharing");
await mkdir(out, { recursive: true });
const timing = new ProbeTiming();
const report: JsonRecord = { at: new Date().toISOString(), platform: process.platform, waits: timing.waits };
const fixture = await prepareFixture(out, report, async () => { const value = await codexFixture(timing); return value; }); report.installation = fixture.installation;
const check = async (name: string, work: () => Promise<unknown>): Promise<void> => {
  try { report[name] = { observed: true, value: await work() }; }
  catch (error) { report[name] = { observed: false, error: String(error) }; }
  process.stdout.write(`${name}: ${JSON.stringify(report[name])}\n`);
};
try {
  const client = await fixture.connect();
  const [a, b] = await Promise.all([fixture.open(client, "A"), fixture.open(client, "B")]);
  assert.ok(a && b && a !== b); report.threads = [a, b];
  await check("cwdIsolation", async () => {
    const results = await Promise.all([fixture.turn(client, a, "A_cwd"), fixture.turn(client, b, "B_cwd")]);
    assert.ok(results.every((result) => result.status === "completed"));
    const directories = fixture.cwds.map((cwd, index) => cwdEvidence(cwd, tools(fixture, `${index === 0 ? "A" : "B"}_cwd`)));
    const texts = [a, b].map((id) => fixture.events.filter((event) => event.params.threadId === id && event.method === "item/completed")
      .map((event) => asRecord(event.params.item)).filter((item) => item?.type === "agentMessage").map((item) => item?.text).join(""));
    assert.ok(texts[0]?.includes("ANSWER_A_cwd") === true && !texts[0].includes("ANSWER_B_cwd"));
    assert.ok(texts[1]?.includes("ANSWER_B_cwd") === true && !texts[1].includes("ANSWER_A_cwd"));
    return { bothCompleted: true, toolsUseOwnDirectory: true, directories, texts };
  });
  await check("mcpIsolation", async () => {
    const results = await Promise.all([fixture.turn(client, a, "A_mcp"), fixture.turn(client, b, "B_mcp")]);
    assert.ok(results.every((result) => result.status === "completed"));
    assert.ok(tools(fixture, "A_mcp").includes("MCP_RESULT=A input=A"));
    assert.ok(!tools(fixture, "A_mcp").includes("MCP_RESULT=B"));
    assert.ok(tools(fixture, "B_mcp").includes("MCP_RESULT=B input=B"));
    assert.ok(!tools(fixture, "B_mcp").includes("MCP_RESULT=A input=A"));
    return { sameServerNameRemainsThreadScoped: true };
  });
  await check("childAttribution", async () => {
    const offset = fixture.events.length;
    const result = await fixture.turn(client, a, "A_spawn");
    const activity = fixture.events.slice(offset).filter((event) => asRecord(event.params.item)?.type === "subAgentActivity");
    const childId = asRecord(activity[0]?.params.item)?.agentThreadId;
    assert.equal(typeof childId, "string", "native subagent activity names its child");
    await timing.until(() => fixture.events.some((event) => event.params.threadId === childId && event.method === "turn/completed"), "child completed");
    const nativeChild = await fixture.request(client, "thread/read", { threadId: childId, includeTurns: false });
    assert.equal(asRecord(nativeChild.thread)?.parentThreadId, a);
    assert.ok(activity.every((event) => event.params.threadId === a));
    assert.ok(a !== b && childId !== b && childId !== a);
    const childRequests = fixture.provider.raw.filter((entry) => asRecord(asRecord(entry.body)?.client_metadata)?.thread_id === childId);
    assert.ok(childRequests.length > 0, "child reached the local provider");
    return { parentCompleted: result.status === "completed", childId, parentThreadId: asRecord(nativeChild.thread)?.parentThreadId,
      nativeActivityScopedToParent: true, peerNotClassifiedAsChild: true, childNotifications: fixture.events.filter((event) => event.params.threadId === childId).length,
      childRequests: childRequests.length };
  });
  await check("loadedResumeOverride", async () => {
    const before = await fixture.request(client, "thread/loaded/list", {});
    const result = await fixture.request(client, "thread/resume", { threadId: a, model: "gpt-5.2", excludeTurns: true });
    const offset = fixture.provider.raw.length;
    const completed = await fixture.turn(client, a, "A_resumed");
    return { before, returnedModel: result.model, requestedModel: "gpt-5.2", status: completed.status,
      providerModels: fixture.provider.raw.slice(offset).map((entry) => asRecord(entry.body)?.model) };
  });
  await check("unsubscribeAndResume", async () => {
    const before = await client.resources();
    const unsubscribe = await fixture.request(client, "thread/unsubscribe", { threadId: a });
    await delay(1000);
    const stillLoaded = await fixture.request(client, "thread/loaded/list", {});
    const after = await client.resources();
    const result = await fixture.request(client, "thread/resume", { threadId: a, model: "gpt-5.2", excludeTurns: true });
    const offset = fixture.provider.raw.length;
    const completed = await fixture.turn(client, a, "A_reloaded");
    return { unsubscribe, stillLoaded, before, after, returnedModel: result.model, status: completed.status,
      providerModels: fixture.provider.raw.slice(offset).map((entry) => asRecord(entry.body)?.model) };
  });
  await check("scopedCleanup", async () => {
    await Promise.all([fixture.turn(client, a, "A_background"), fixture.turn(client, b, "B_background")]);
    const markers = await Promise.all(["A", "B"].map(async (label) => {
      const text = await readFile(path.join(fixture.home, `${label}.json`), "utf8");
      const marker = asRecord(JSON.parse(text));
      assert.equal(typeof marker?.parent, "number"); assert.equal(typeof marker?.child, "number");
      return identities([Number(marker?.parent), Number(marker?.child)]);
    }));
    const target = await fixture.request(client, "thread/backgroundTerminals/list", { threadId: a });
    const peer = await fixture.request(client, "thread/backgroundTerminals/list", { threadId: b });
    const targetId = asRecord(Array.isArray(target.data) ? target.data[0] : null)?.processId;
    assert.equal(typeof targetId, "string");
    const wrongOwner = await fixture.request(client, "thread/backgroundTerminals/terminate", { threadId: b, processId: targetId });
    const targetAfterWrongOwner = await fixture.request(client, "thread/backgroundTerminals/list", { threadId: a });
    const wrongOwnerSurvivors = markers.map((entries) => running(entries));
    const terminated = await fixture.request(client, "thread/backgroundTerminals/terminate", { threadId: a, processId: targetId });
    await delay(1000);
    const targetAfter = await fixture.request(client, "thread/backgroundTerminals/list", { threadId: a });
    const peerAfter = await fixture.request(client, "thread/backgroundTerminals/list", { threadId: b });
    const survivors = markers.map((entries) => running(entries));
    const peerId = asRecord(Array.isArray(peer.data) ? peer.data[0] : null)?.processId;
    await fixture.request(client, "thread/backgroundTerminals/terminate", { threadId: b, processId: peerId });
    return { target, peer, wrongOwner, targetAfterWrongOwner, wrongOwnerSurvivors, terminated, targetAfter, peerAfter, markers,
      survivors };
  });
  await check("cancelDoesNotStopPeer", async () => {
    const [targetTurn, peerTurn] = await Promise.all([fixture.start(client, a, "A_hold"), fixture.start(client, b, "B_hold")]);
    assert.ok(targetTurn && peerTurn);
    await timing.until(() => fixture.gates.has("A_hold") && fixture.gates.has("B_hold"), "both providers held");
    await fixture.request(client, "turn/interrupt", { threadId: a, turnId: targetTurn });
    await timing.until(() => fixture.ended(a, targetTurn) !== null, "target interrupted");
    const peerStillRunning = fixture.ended(b, peerTurn) === null;
    fixture.gates.get("A_hold")?.resolve(); fixture.gates.get("B_hold")?.resolve();
    await timing.until(() => fixture.ended(b, peerTurn) !== null, "peer completed");
    return { target: fixture.ended(a, targetTurn)?.status, peerStillRunning, peer: fixture.ended(b, peerTurn)?.status };
  });
  await check("concurrentUnsubscribeResume", async () => {
    const results = await Promise.allSettled([
      fixture.request(client, "thread/unsubscribe", { threadId: a }),
      fixture.request(client, "thread/resume", { threadId: a, model: "gpt-5.1", excludeTurns: true }),
    ]);
    const loaded = await fixture.request(client, "thread/loaded/list", {});
    const resumed = await fixture.request(client, "thread/resume", { threadId: a, excludeTurns: true });
    const completed = await fixture.turn(client, a, "A_raced");
    return { results, loaded, model: resumed.model, threadId: asRecord(resumed.thread)?.id, turn: completed.status };
  });
  await check("processExitWithTwoActiveThreads", async () => {
    fixture.gates.delete("A_hold"); fixture.gates.delete("B_hold");
    const [targetTurn, peerTurn] = await Promise.all([fixture.start(client, a, "A_hold"), fixture.start(client, b, "B_hold")]);
    await timing.until(() => fixture.gates.has("A_hold") && fixture.gates.has("B_hold"), "both turns active before exit");
    const endOffset = fixture.events.length;
    fixture.crash(client); const exit = await timing.wait(client.exited, "app-server exit after fault");
    const reads = await Promise.allSettled([fixture.request(client, "thread/read", { threadId: a }), fixture.request(client, "thread/read", { threadId: b })]);
    return { exit, reads: reads.map((entry) => entry.status), targetTurn, peerTurn,
      completionsAfterExit: fixture.events.slice(endOffset).filter((event) => event.method === "turn/completed") };
  });
} finally {
  report.calls = fixture.calls; report.events = fixture.events; report.provider = fixture.provider.raw; report.normalized = fixture.seen;
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fixture.stop();
}

assert.ok(Object.values(report).every((value) => asRecord(value)?.observed !== false), "one or more observations failed; inspect evidence.json");
