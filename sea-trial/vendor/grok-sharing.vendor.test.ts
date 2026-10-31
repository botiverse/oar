/* oxlint-disable import/max-dependencies, eslint/max-statements, eslint/max-lines-per-function -- Real shared and isolated lifecycle controls retain native timing and cleanup evidence. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { grokRuntime } from "../../packages/oar/src/runtimes/grok/index.js";
// oxlint-disable-next-line import/no-namespace -- Observe actual native processes and wire ingress before SDK dispatch.
import * as acp from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { acpFixture } from "../../experiments/sharing/acp-fixture.js";
import { preservingProbeEvidence, probeErrorText } from "../../experiments/sharing/fixture-lifetime.js";
import { cwdEvidence } from "../../experiments/sharing/observation.js";
import { cleanupObserver } from "./support/opencode-cleanup.js";

const enabled = process.env.OAR_TEST === "grok-shared";
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
interface Wire { method: string; params: JsonRecord; at: number }
function childTiming(session: Session, peer: Session, wire: readonly Wire[]) {
  const relation = session.graph().edges.find(e => e.parent === session.id && e.child !== session.id);
  expect(relation).toBeDefined(); if (relation === undefined) { throw new Error("Missing native child association"); }
  const child = relation.child;
  const spawned = wire.find(e => e.method === "_x.ai/session_notification" && e.params.sessionId === session.id
    && asRecord(e.params.update)?.sessionUpdate === "subagent_spawned" && asRecord(e.params.update)?.child_session_id === child);
  const children = wire.filter(e => e.params.sessionId === child);
  const completion = wire.find(e => e.params.sessionId === session.id && asRecord(asRecord(e.params.update)?.rawOutput)?.type === "SubagentCompleted");
  expect(spawned).toBeDefined(); expect(children.length).toBeGreaterThan(0);
  expect(asRecord(asRecord(completion?.params.update)?.rawOutput)?.subagent_id).toBe(child);
  if (spawned === undefined || children[0] === undefined) { throw new Error("Missing child ingress timing"); }
  // Negative means ancestry already existed. Positive must fit the adapter's reordering window.
  const associationMinusFirstChildMs = spawned.at - children[0].at;
  expect(associationMinusFirstChildMs).toBeLessThan(1000);
  expect(session.records().some(r => r.kind === "frame" && r.sessionId === child && r.body.events.some(e => e.kind === "text_delta"))).toBe(true);
  expect(peer.records().some(r => r.sessionId === child)).toBe(false);
  return { child, childFrames: children.length, associationMinusFirstChildMs, completedMinusFirstChildMs: completion === undefined ? null : completion.at - children[0].at };
}

for (const placement of ["auto", "isolated"] as const) {
  test.skipIf(!enabled)(`Grok 1.0.70 ${placement}: same-directory roots, child timing, cancel, terminals and final lease`, async () => {
    const f = await acpFixture("grok"); const sessions: Session[] = []; const runtimes: acp.AcpProcess[] = []; const wire: Wire[] = [];
    const original = acp.startAcpProcess;
    const spy = vi.spyOn(acp, "startAcpProcess").mockImplementation((command, args, app, options = {}) => {
      const runtime = original(command, args, app, { ...options, incoming: message => {
        if ("method" in message && !("id" in message)) { const params = asRecord(message.params); if (params !== null) { wire.push({ method: message.method, params, at: performance.now() }); } }
        return options.incoming === undefined ? message : options.incoming(message);
      } }); runtimes.push(runtime); return runtime;
    });
    const runtime = grokRuntime.withPlacement(placement);
    const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...f.env,
      PATH: (f.env.PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry)).join(path.delimiter) };
    const open = async (label: "A" | "B", extra: Partial<SessionOptions> = {}): Promise<Session> => {
      const session = await runtime.session(f.installation, { cwd: f.cwds[0] ?? f.home, env,
        mcpServers: [{ name: "scope", command: process.execPath, args: [f.mcp.script, label] }], ...extra }); sessions.push(session); return session;
    };
    const cleanup = cleanupObserver(f.home, "grok"); const errors: unknown[] = []; let timing: unknown = null;
    try {
      await writeFile(path.join(f.home, "tool.cjs"), [
        "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const path=require('node:path');",
        "if(process.argv[2]==='cwd')console.log('CWD_RESULT='+process.cwd());",
        "else{const file=process.argv[3].replace('.json','-child.json');",
        // oxlint-disable-next-line eslint/no-template-curly-in-string -- The generated fixture evaluates this template.
        "const child=spawn(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:process.pid,ppid:process.ppid}));setTimeout(()=>{},300000)`],{stdio:'ignore'});",
        "writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,child:child.pid,cwd:process.cwd()}));console.log('TOOL_READY');setTimeout(()=>{},300000);}",
      ].join("\n"));
      const configPath = path.join(f.env.GROK_HOME ?? "", "config.toml");
      const config = await readFile(configPath, "utf8");
      const model = config.slice(config.indexOf("[model.aimock-model]"));
      await writeFile(configPath, `${config}\n${model.replaceAll("aimock-model", "aimock-other")}\n`);
      expect(f.installation.version).toMatch(/^grok 1\.0\.70 \([a-f\d]+\) \[stable\]$/u);
      const [a, b] = await Promise.all([open("A"), open("B", { model: "aimock-other" })]);
      expect(runtimes).toHaveLength(placement === "auto" ? 1 : 2);
      for (const session of [a, b]) {
        expect(session.placement).toBe(placement === "auto" ? "shared" : "isolated");
        expect(session.model()).toMatchObject({ value: session === a ? "aimock-model" : "aimock-other" });
      }
      for (const session of [a, b]) {
        const reading = await session.resources?.();
        if (process.platform === "win32") { expect(reading).toBeNull(); }
        else { expect(reading?.rss).toBeGreaterThan(0); expect(reading?.scope).toBe(placement === "auto" ? "shared_process" : undefined); }
      }
      for (const call of spy.mock.calls) { expect(call[1]).toEqual(["agent", "--always-approve", "--no-leader", "stdio"]); }
      await Promise.all([promptAndWait(a, "ACP_SHARE_A_cwd"), promptAndWait(b, "ACP_SHARE_B_cwd")]);
      cwdEvidence(f.cwds[0] ?? f.home, f.seen.filter(s => s.key === "A_cwd"));
      cwdEvidence(f.cwds[0] ?? f.home, f.seen.filter(s => s.key === "B_cwd"));
      for (const [key, expected] of [["A_cwd", "aimock-model"], ["B_cwd", "aimock-other"]]) {
        const models = f.seen.filter(s => s.key === key).map(s => asRecord(s.request)?.model);
        expect(models.length).toBeGreaterThanOrEqual(2); expect([...new Set(models)]).toEqual([expected]);
      }
      await Promise.all([promptAndWait(a, "ACP_SHARE_A_mcp"), promptAndWait(b, "ACP_SHARE_B_mcp")]);
      expect(await f.mcp.calls()).toEqual(expect.arrayContaining([{ server: "A", input: "A", output: "MCP_RESULT=A input=A" }, { server: "B", input: "B", output: "MCP_RESULT=B input=B" }]));
      await Promise.all([promptAndWait(a, "ACP_SHARE_A_child"), promptAndWait(b, "ACP_SHARE_B_peer")]);
      timing = childTiming(a, b, wire);
      const pending = await a.prompt("ACP_SHARE_A_hold");
      await expect.poll(() => f.stages.get("A_hold") ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
      await a.abort(); expect(await awaitTurnEnd(a, pending.request.seq)).toMatchObject({ kind: "aborted" });
      expect(await promptAndWait(b, "ACP_SHARE_B_afterabort")).toMatchObject({ kind: "ended" });
      const tools = await Promise.all([a.prompt("ACP_SHARE_A_tool"), b.prompt("ACP_SHARE_B_tool")]);
      const ids: { parent: number; child: number }[] = [];
      for (const label of ["A", "B"]) {
        await expect.poll(async () => { const value = await readFile(path.join(f.home, `${label}-child.json`), "utf8").catch(() => ""); return value; }, { timeout: 30_000 }).not.toBe("");
        const parentText = await readFile(path.join(f.home, `${label}.json`), "utf8");
        const childText = await readFile(path.join(f.home, `${label}-child.json`), "utf8");
        const parent = asRecord(JSON.parse(parentText)); const child = asRecord(JSON.parse(childText));
        expect(typeof parent?.parent).toBe("number"); expect(typeof parent?.child).toBe("number");
        const pair = { parent: Number(parent?.parent), child: Number(parent?.child) }; ids.push(pair);
        expect(child).toMatchObject({ pid: pair.child, ppid: pair.parent }); expect(alive(pair.parent)).toBe(true); expect(alive(pair.child)).toBe(true);
      }
      await cleanup.sample("before-dispose");
      await a.dispose(); await awaitTurnEnd(a, tools[0].request.seq);
      await expect.poll(() => [alive(ids[0]?.parent ?? -1), alive(ids[0]?.child ?? -1)], { timeout: 15_000 }).toEqual([false, false]);
      expect(alive(ids[1]?.parent ?? -1)).toBe(true); expect(alive(ids[1]?.child ?? -1)).toBe(true);
      expect(a.records().filter(r => r.kind === "response" && r.body.kind === (placement === "auto" ? "released" : "exited"))).toHaveLength(1);
      const reused = await open("A"); expect(reused.placement).toBe(placement === "auto" ? "shared" : "isolated");
      await promptAndWait(reused, "ACP_SHARE_A_mcpafter"); await reused.dispose();
      const otherDirectory = await open("B", { cwd: f.cwds[1] ?? f.home });
      await promptAndWait(otherDirectory, "ACP_SHARE_B_mcpother"); await otherDirectory.dispose();
      if (placement === "auto") { expect(runtimes).toHaveLength(1); }
      // B is the last lease with a live owned terminal tree, not an empty idle session.
      await b.dispose(); await awaitTurnEnd(b, tools[1].request.seq);
      await expect.poll(() => [alive(ids[1]?.parent ?? -1), alive(ids[1]?.child ?? -1)], { timeout: 15_000 }).toEqual([false, false]);
      expect(b.records().filter(r => r.kind === "response" && r.body.kind === "exited")).toHaveLength(1);
      expect(runtimes.every(r => r.closed)).toBe(true);
      // Recheck the complete log after every turn to catch delayed duplicate or misrouted calls.
      expect(await f.mcp.calls()).toHaveLength(4);
      expect(await f.mcp.calls()).toEqual(expect.arrayContaining([
        { server: "A", input: "A_mcpafter", output: "MCP_RESULT=A input=A_mcpafter" },
        { server: "B", input: "B_mcpother", output: "MCP_RESULT=B input=B_mcpother" },
      ]));
      const resumed = await open("A", { resume: a.id }); expect(resumed.id).toBe(a.id);
      expect(await promptAndWait(resumed, "ACP_SHARE_A_resumed")).toMatchObject({ kind: "ended" }); await resumed.dispose();
    } catch (error) { errors.push(error); }
    await preservingProbeEvidence(async () => { if (errors.length > 0) { throw errors[0]; } }, [
      async () => { const results = await Promise.allSettled(sessions.map(async s => { await s.dispose(); })); const failures = results.filter(r => r.status === "rejected");
        if (failures.length > 0) { const error = new AggregateError(failures.map((r): unknown => r.reason), "Session disposal failed"); errors.push(error); throw error; } },
      async () => { await cleanup.sample("before-directory-removal"); },
      async () => { try { await cleanup.reclaim(); } catch (error) { errors.push(error); throw error; } },
      async () => {
        const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "grok-sharing"); await mkdir(out, { recursive: true });
        await writeFile(path.join(out, `${placement}.json`), JSON.stringify({ version: f.installation.version, errors: errors.map(error => probeErrorText(error)), timing,
          cleanup: cleanup.observations, runtimes: runtimes.map(r => ({ closed: r.closed, diagnostics: r.diagnostics() })),
          sessions: sessions.map(s => ({ placement: s.placement, records: s.records() })) }, null, 2));
      },
      () => { spy.mockRestore(); }, async () => { await f.stop(); },
    ]);
  }, 240_000);
}
