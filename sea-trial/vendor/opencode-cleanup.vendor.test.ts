/* oxlint-disable import/max-dependencies, eslint/max-statements, eslint/max-lines-per-function -- Real adapter lifecycle scenarios share one native process and retain all cleanup evidence. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { reportedProcess, alive, fixtureIdentityPath } from "../../tests/fixtures/process-tree.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
// oxlint-disable-next-line import/no-namespace -- Spy observes real native launches without replacing their behavior.
import * as acp from "../../packages/oar/src/shared/acp/process.js";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { acpFixture } from "../../experiments/sharing/acp-fixture.js";
import { cleanupObserver } from "./support/opencode-cleanup.js";
import { preservingProbeEvidence, probeErrorText } from "../../experiments/sharing/fixture-lifetime.js";
import { cwdEvidence } from "../../experiments/sharing/observation.js";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";

const enabled = process.env.OAR_TEST === "opencode-cleanup";
const expectedVersion = process.env.OAR_CI_CANDIDATE_VERSION ?? "2.2.7";
function text(session: Session): string { return session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : []).join(""); }

for (const placement of ["isolated"] as const) {
  test.skipIf(!enabled)(`OpenCode ${expectedVersion} ${placement}: routed roots, MCP, children, cancel, cleanup and resume`, async () => {
    const f = await acpFixture("opencode");
    const sessions: Session[] = [];
    const runtimes: acp.AcpProcess[] = [];
    const original = acp.startAcpProcess;
    const spy = vi.spyOn(acp, "startAcpProcess").mockImplementation((...args) => { const runtime = original(...args); runtimes.push(runtime); return runtime; });
    const runtime = opencodeRuntime.withPlacement(placement);
    const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...f.env, PATH: (f.env.PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry)).join(path.delimiter) };
    const open = async (label: "A" | "B", extra: Partial<SessionOptions> = {}): Promise<Session> => {
      const session = await runtime.session(f.installation, { cwd: f.cwds[label === "A" ? 0 : 1] ?? f.home, env,
        mcpServers: [{ name: "scope", command: process.execPath, args: [f.mcp.script, label] }], ...extra });
      sessions.push(session); return session;
    };
    const cleanup = cleanupObserver(f.home);
    const errors: unknown[] = [];
    try {
      // Every tool reports its own cwd and parent; no guessed Windows cwd from CIM.
      await writeFile(path.join(f.home, "tool.cjs"), [
        "const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const path=require('node:path');",
        "if(process.argv[2]==='cwd')console.log('CWD_RESULT='+process.cwd());",
        "else { const file=path.join(path.dirname(process.argv[3]),'A-child.json');",
        // oxlint-disable-next-line eslint/no-template-curly-in-string -- Template is evaluated by the generated fixture, not by this test.
        "const child=spawn(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd(),executable:process.execPath}));setTimeout(()=>{},300000)`],{stdio:'ignore'});",
        `const {captureProcess}=require(${JSON.stringify(fixtureIdentityPath)});writeFileSync(process.argv[3],JSON.stringify({parent:captureProcess(process.pid),ppid:process.ppid,child:captureProcess(child.pid),cwd:process.cwd(),executable:process.execPath})); console.log('TOOL_READY');setTimeout(()=>{},300000); }`,
      ].join("\n"));
      const configPath = path.join(f.provider.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
      const configText = await readFile(configPath, "utf8");
      const config = asRecord(JSON.parse(configText));
      const provider = asRecord(asRecord(config?.provider)?.aimock);
      const models = asRecord(provider?.models);
      expect(models).not.toBeNull();
      if (models !== null && provider !== null && config !== null) {
        models["aimock-other"] = models["aimock-model"];
        provider.models = models;
        config.provider = { ...asRecord(config.provider), aimock: provider };
        await writeFile(configPath, JSON.stringify(config));
      }
      expect(f.installation.version?.replace(/^(?:opencode\s+)?v?/u, "")).toBe(expectedVersion);
      // Independent processes start sequentially to avoid the separately documented cold DB race.
      const [a, b] = [await open("A"), await open("B", { model: "aimock/aimock-other" })];
      expect(runtimes).toHaveLength(2);
      for (const session of [a, b]) {
        expect(session.placement).toBe("isolated");
        expect(session.model()).toMatchObject({ value: session === a ? "aimock/aimock-model" : "aimock/aimock-other" });
      }
      const readings = await Promise.all([a.resources?.(), b.resources?.()]);
      for (const resources of readings) {
        if (process.platform === "win32") { expect(resources).toBeNull(); }
        else { expect(resources?.rss).toBeGreaterThan(0); expect(resources?.scope).toBe(undefined); }
      }
      await Promise.all([promptAndWait(a, "ACP_SHARE_A_cwd"), promptAndWait(b, "ACP_SHARE_B_cwd")]);
      expect(JSON.stringify(f.seen.filter(s => s.key === "A_cwd"))).toContain(f.cwds[0]?.replaceAll("\\", String.raw`\\`));
      expect(JSON.stringify(f.seen.filter(s => s.key === "B_cwd"))).toContain(f.cwds[1]?.replaceAll("\\", String.raw`\\`));
      // Native tool output may expand Windows 8.3 aliases; it must still name exactly the right directory.
      cwdEvidence(f.cwds[0] ?? f.home, f.seen.filter(s => s.key === "A_cwd"));
      cwdEvidence(f.cwds[1] ?? f.home, f.seen.filter(s => s.key === "B_cwd"));
      const mcp = await Promise.all([promptAndWait(a, "ACP_SHARE_A_mcp"), promptAndWait(b, "ACP_SHARE_B_mcp")]);
      expect(mcp.map(r => r.kind)).toEqual(["ended", "ended"]);
      expect(await f.mcp.calls()).toEqual(expect.arrayContaining([{ server: "A", input: "A", output: "MCP_RESULT=A input=A" }, { server: "B", input: "B", output: "MCP_RESULT=B input=B" }]));
      await promptAndWait(a, "ACP_SHARE_A_child");
      expect(a.graph().edges.some(e => e.parent === a.id && e.child !== a.id)).toBe(true);
      expect(b.graph().edges).toEqual([]);
      expect(text(b)).not.toContain("ANSWER_A_childreply");
      const pending = await a.prompt("ACP_SHARE_A_hold");
      await expect.poll(() => f.stages.get("A_hold") ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      await a.abort();
      expect(await awaitTurnEnd(a, pending.request.seq)).toMatchObject({ kind: "aborted" });
      expect(await promptAndWait(b, "ACP_SHARE_B_peer")).toMatchObject({ kind: "ended" });
      const runningTool = await a.prompt("ACP_SHARE_A_tool");
      await expect.poll(async () => readFile(path.join(f.home, "A.json"), "utf8").catch(() => ""), { timeout: 30_000 }).not.toBe("");
      const toolFile = await readFile(path.join(f.home, "A.json"), "utf8");
      const tool = asRecord(JSON.parse(toolFile));

      const child = reportedProcess(tool?.child), parent = reportedProcess(tool?.parent);
      await expect.poll(async () => readFile(path.join(f.home, "A-child.json"), "utf8").catch(() => ""), { timeout: 30_000 }).not.toBe("");
      const childReadyFile = await readFile(path.join(f.home, "A-child.json"), "utf8");
      const childReady = asRecord(JSON.parse(childReadyFile));
      expect(childReady).toMatchObject({ pid: child.pid, ppid: parent.pid });
      expect(alive(parent)).toBe(true); expect(alive(child)).toBe(true);
      await cleanup.sample("before-dispose");
      await a.dispose(); await awaitTurnEnd(a, runningTool.request.seq);
      await cleanup.sample("after-dispose");
      await expect.poll(() => [alive(parent), alive(child)], { timeout: 15_000 }).toEqual([false, false]);
      expect(await promptAndWait(b, "ACP_SHARE_B_afterclose")).toMatchObject({ kind: "ended" });
      expect(a.records().filter(r => r.kind === "response" && r.body.kind === "exited")).toHaveLength(1);
      const resumed = await open("A", { resume: a.id });
      expect(resumed.id).toBe(a.id); expect(resumed.placement).toBe("isolated");
      expect(await promptAndWait(resumed, "ACP_SHARE_A_resumed")).toMatchObject({ kind: "ended" });
      await resumed.dispose(); await b.dispose();
      expect(b.records().filter(r => r.kind === "response" && r.body.kind === "exited")).toHaveLength(1);
      expect(runtimes.every(r => r.closed)).toBe(true);
      expect(await f.mcp.calls()).toHaveLength(2);
    } catch (error) { errors.push(error); }
    await preservingProbeEvidence(async () => {
      if (errors.length > 0) { throw errors[0]; }
    }, [
      async () => { const results = await Promise.allSettled(sessions.map(async session => { await session.dispose(); }));
        const failed: unknown[] = [];
        for (const result of results) { if (result.status === "rejected") { failed.push(result.reason); } }
        errors.push(...failed); if (failed.length > 0) { throw new AggregateError(failed, "Session disposal failed"); } },
      async () => { await cleanup.sample("before-directory-removal"); },
      async () => { try { await cleanup.reclaim(); } catch (error) { errors.push(error); throw error; } },
      async () => {
        const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "opencode-cleanup");
        await mkdir(out, { recursive: true });
        await writeFile(path.join(out, `${placement}.json`), JSON.stringify({ version: f.installation.version, errors: errors.map(error => probeErrorText(error)),
          cleanup: cleanup.observations, runtimes: runtimes.map(r => ({ closed: r.closed, diagnostics: r.diagnostics() })),
          sessions: sessions.map(s => ({ placement: s.placement, records: s.records() })) }, null, 2));
      },
      () => { spy.mockRestore(); },
      async () => { await f.stop(); },
    ]);
  }, 240_000);
}

// Session prompts through the native config overlay: a custom default agent, a disabled built-in that must stay
// disabled, then a resume that replaces the system prompt (experiments/opencode-v2-prompts).
test.skipIf(!enabled)(`OpenCode ${expectedVersion}: systemPrompt and appendSystemPrompt reach the model on a new session and its resume`, async () => {
  const { startOpencodeAimock } = await import("../harness/aimock-acp.js");
  const requests: string[] = [];
  const updates: string[] = [];
  const fixture = await startOpencodeAimock(mock => {
    mock.on({ predicate: request => (request.tools ?? []).length > 0 }, request => {
      requests.push(JSON.stringify(request.messages.filter(message => message.role === "system")));
      updates.push(JSON.stringify(request.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("system-update"))));
      return { content: "Complete" };
    });
  }, { default_agent: "review", agents: { review: { mode: "primary", description: "Fixture review agent", system: "USER-REVIEW-PROMPT" }, plan: { disabled: true } } });
  const installation = await opencodeRuntime.installation();
  expect(installation.kind).toBe("available");
  if (installation.kind !== "available") { return; }
  const base: SessionOptions = { cwd: fixture.env.HOME ?? "", env: fixture.env, model: "aimock/aimock-model" };
  try {
    const first = await opencodeRuntime.session(installation, { ...base, systemPrompt: "OAR-SYSTEM-ONE", appendSystemPrompt: "OAR-APPEND-ONE" });
    try {
      // The disabled built-in stays out of the session's mode choices: the overlay did not bring it back.
      const opened = first.records().find(record => record.kind === "frame" && record.body.type === "session/new");
      const modes = opened?.kind === "frame" ? asRecordList(asRecord(opened.body.native)?.configOptions).find(option => option.category === "mode") : undefined;
      const choices = asRecordList(modes?.options).map(option => option.value);
      expect(choices).toEqual(expect.arrayContaining(["review", "build"]));
      expect(choices).not.toContain("plan");
      expect(modes?.currentValue).toBe("review");
      expect(await promptAndWait(first, "first")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await first.dispose(); }
    expect(requests.at(-1)).toContain("OAR-SYSTEM-ONE");
    expect(requests.at(-1)).toContain("OAR-APPEND-ONE");
    expect(requests.at(-1)).not.toContain("USER-REVIEW-PROMPT");
    const resumed = await opencodeRuntime.session(installation, { ...base, resume: first.id, systemPrompt: "OAR-SYSTEM-TWO" });
    try {
      expect(await promptAndWait(resumed, "second")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await resumed.dispose(); }
    expect(requests.at(-1)).toContain("OAR-SYSTEM-TWO");
    expect(requests.at(-1)).not.toContain("OAR-SYSTEM-ONE");
    // The first file's text stays in the saved system snapshot; OpenCode retracts it in a user update.
    expect(updates.at(-1)).toContain("no longer apply");
  } finally { await fixture.stop(); }
}, 180_000);
