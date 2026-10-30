/** ACP rule-5 evidence with local model substitutes. No OAR pool is enabled.
 * pnpm tsx experiments/sharing/acp.ts kimi|grok|opencode|antigravity [output-dir]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpId, acpFixture, type AcpFixture } from "./acp-fixture.js";
import { ProbeTiming, cwdEvidence, prepareFixture } from "./observation.js";
import { identities, running } from "./processes.js";

function toolOutput(fixture: AcpFixture, key: string): string {
  return fixture.seen.filter((entry) => entry.key === key).flatMap((entry) => {
    const messages = asRecord(entry.request)?.messages;
    const rows: readonly unknown[] = Array.isArray(messages) ? messages : [];
    return rows.filter((message: unknown) => asRecord(message)?.role === "tool");
  }).map((message: unknown) => typeof asRecord(message)?.content === "string" ? asRecord(message)?.content : JSON.stringify(asRecord(message)?.content)).join("\n");
}
const id = acpId(process.argv[2] ?? "kimi");
const out = path.resolve(process.argv[3] ?? `oar-trial-run/shared-${id}`); await mkdir(out, { recursive: true });
const timing = new ProbeTiming();
const report: JsonRecord = { id, at: new Date().toISOString(), platform: process.platform, waits: timing.waits };
const fixture = await prepareFixture(out, report, async () => { const value = await acpFixture(id, timing); return value; }); report.installation = fixture.installation;
const observe = async (name: string, work: () => Promise<unknown>): Promise<void> => {
  try { report[name] = { observed: true, value: await work() }; } catch (error) { report[name] = { observed: false, error: String(error) }; }
  process.stdout.write(`${name}: ${JSON.stringify(report[name])}\n`);
};
const pending: Promise<unknown>[] = [];
try {
  const connection = await fixture.connect(); const { child, initialized } = connection;
  report.initialize = initialized;
  const [a, b] = await Promise.all([fixture.open(connection, "A"), fixture.open(connection, "B")]); assert.notEqual(a.id, b.id);
  report.sessions = [a, b];
  const prompt = async (session: typeof a, phase: string): Promise<JsonRecord> => {
    const response = await fixture.prompt(child, session.id, `${session.label}_${phase}`); return response;
  };
  await observe("cwdAndMessageIsolation", async () => {
    const responses = await Promise.all([prompt(a, "cwd"), prompt(b, "cwd")]);
    const directories = [a, b].map((session) => cwdEvidence(session.cwd, toolOutput(fixture, `${session.label}_cwd`)));
    const texts = [a, b].map((session) => fixture.events.filter((event) => event.params.sessionId === session.id)
      .map((event) => asRecord(asRecord(event.params.update)?.content)?.text).filter((text) => typeof text === "string").join(""));
    assert.ok(texts[0]?.includes("ANSWER_A_cwd") === true && !texts[0].includes("ANSWER_B_cwd"));
    assert.ok(texts[1]?.includes("ANSWER_B_cwd") === true && !texts[1].includes("ANSWER_A_cwd"));
    return { responses, texts, directories, cwdFromExplicitToolArgument: id === "antigravity" };
  });
  await observe("mcpIsolation", async () => {
    const responses = await Promise.all([prompt(a, "mcp"), prompt(b, "mcp")]);
    assert.ok(toolOutput(fixture, "A_mcp").includes("MCP_RESULT=A input=A") && !toolOutput(fixture, "A_mcp").includes("MCP_RESULT=B input=B"));
    assert.ok(toolOutput(fixture, "B_mcp").includes("MCP_RESULT=B input=B") && !toolOutput(fixture, "B_mcp").includes("MCP_RESULT=A input=A"));
    return { responses, sameServerNameScopedToSession: true };
  });
  await observe("childAttribution", async () => {
    const offset = fixture.events.length;
    const responses = await Promise.all([prompt(a, "child"), prompt(b, "childpeer")]);
    await timing.until(() => fixture.seen.some((entry) => entry.key === "A_childreply"), "child reached the local provider");
    await delay(500);
    const events = fixture.events.slice(offset);
    const rootPeer = events.filter((event) => event.params.sessionId === b.id);
    assert.ok(!JSON.stringify(rootPeer).includes("ANSWER_A_childreply"));
    const sessionIds = [...new Set(events.map((event) => event.params.sessionId).filter((value) => typeof value === "string"))];
    return { responses, childRequests: fixture.seen.filter((entry) => entry.key === "A_childreply").length,
      rootIds: [a.id, b.id], eventSessionIds: sessionIds, peerReceivedChildReply: false, events };
  });
  const capabilities = asRecord(initialized.agentCapabilities); const resumeCapability = asRecord(capabilities?.sessionCapabilities)?.resume;
  const resumeMethod = resumeCapability === true || asRecord(resumeCapability) !== null ? "session/resume" : "session/load";
  const resume = async (session: typeof a): Promise<JsonRecord> => {
    const result = await fixture.request(child, resumeMethod, { sessionId: session.id, cwd: session.cwd, mcpServers: fixture.mcpServers(session.label) });
    await fixture.profile.configureSession?.({ request: async (method, params) => { const response = await fixture.request(child, method, params); return response; },
      sessionId: session.id, response: result, options: { cwd: session.cwd } });
    return result;
  };
  await observe("loadedResume", async () => {
    const result = await resume(a); const response = await prompt(a, "resumed");
    const model = fixture.seen.filter((entry) => entry.key === "A_resumed").map((entry) => asRecord(entry.request)?.model);
    const retainedHistory = fixture.seen.filter((entry) => entry.key === "A_resumed").some((entry) => JSON.stringify(asRecord(entry.request)?.messages).includes("ANSWER_A_cwd"));
    return { method: resumeMethod, result, response, providerModels: model, retainedHistory };
  });
  await observe("scopedCleanup", async () => {
    const ends = new Map<string, unknown>();
    const held = async (session: typeof a): Promise<void> => {
      try { const value = await prompt(session, "tool"); ends.set(session.id, { value }); }
      catch (error) { ends.set(session.id, { error: String(error) }); }
    };
    const target = held(a); const peer = held(b); pending.push(target, peer);
    const markers = await Promise.all([a, b].map(async (session) => {
      const file = path.join(fixture.home, `${session.label}.json`);
      await timing.until(async () => { try { await readFile(file); return true; } catch { return false; } }, `${session.label} tool starts`);
      const values = asRecord(JSON.parse(await readFile(file, "utf8"))); assert.ok(values);
      return identities([Number(values.parent), Number(values.child)]);
    }));
    await child.connection.agent.notify("session/cancel", { sessionId: a.id }); await delay(2000);
    const afterCancel = markers.map((entries) => running(entries)); const peerEndedBeforeRelease = ends.has(b.id);
    const closed = await fixture.request(child, "session/close", { sessionId: a.id }).then((value) => ({ value }), (error: unknown) => ({ error: String(error) }));
    await delay(1000); const afterNativeClose = markers.map((entries) => running(entries));
    await fixture.terminalFor(a.id).dispose(); await delay(1000); const afterHostCleanup = markers.map((entries) => running(entries));
    const targetEnd = ends.get(a.id) ?? null;
    // Clean the peer only after recording its continued execution.
    await child.connection.agent.notify("session/cancel", { sessionId: b.id });
    const peerClosed = await fixture.request(child, "session/close", { sessionId: b.id }).then((value) => ({ value }), (error: unknown) => ({ error: String(error) }));
    await fixture.terminalFor(b.id).dispose();
    fixture.gates.get("A_tool")?.resolve(); fixture.gates.get("B_tool")?.resolve();
    await timing.wait(Promise.all([target, peer]), "tool turns settle after cleanup");
    return { targetEnd, peerEndedBeforeRelease, markers, afterCancel, closed, afterNativeClose, afterHostCleanup, peerClosed };
  });
  await observe("closeResumeRace", async () => {
    await resume(a);
    const results = await Promise.allSettled([fixture.request(child, "session/close", { sessionId: a.id }), resume(a)]);
    const result = await resume(a); const response = await prompt(a, "raced");
    return { results, result, response };
  });
  await observe("exitWithActiveSessions", async () => {
    await resume(b);
    const ends: { session: string; value?: unknown; error?: string }[] = [];
    const active = [a, b].map(async (session) => {
      try { const value = await prompt(session, "exit"); ends.push({ session: session.id, value }); }
      catch (error) { ends.push({ session: session.id, error: String(error) }); }
    });
    pending.push(...active);
    await timing.until(() => fixture.gates.has("A_exit") && fixture.gates.has("B_exit"), "both model requests active");
    const endedBeforeExit = ends.length;
    fixture.crash(child); const exit = await timing.wait(child.exited, "ACP exit after fault"); await timing.wait(Promise.all(active), "active ACP prompts settle after fault");
    return { endedBeforeExit, exit, ends };
  });
} finally {
  report.events = fixture.events; report.calls = fixture.calls; report.normalized = fixture.seen; report.provider = fixture.provider.raw;
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fixture.stop(); await Promise.allSettled(pending);
}

assert.ok(Object.values(report).every((value) => asRecord(value)?.observed !== false), "one or more observations failed; inspect evidence.json");
