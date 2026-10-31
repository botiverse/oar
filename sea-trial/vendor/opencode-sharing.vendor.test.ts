/* oxlint-disable import/max-dependencies, eslint/max-statements, eslint/max-lines-per-function -- Real adapter lifecycle scenarios share one native process and retain all cleanup evidence. */
import { readFile, writeFile, mkdir, symlink, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
// oxlint-disable-next-line import/no-namespace -- Spy observes real native launches without replacing their behavior.
import * as acp from "../../packages/oar/src/shared/acp/process.js";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { acpFixture } from "../../experiments/sharing/acp-fixture.js";
import { cleanupObserver } from "./support/opencode-cleanup.js";
import { preservingProbeEvidence, probeErrorText } from "../../experiments/sharing/fixture-lifetime.js";
import { cwdEvidence } from "../../experiments/sharing/observation.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const enabled = process.env.OAR_TEST === "opencode-shared";
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function text(session: Session): string { return session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : []).join(""); }

for (const placement of ["auto", "isolated"] as const) {
  test.skipIf(!enabled)(`OpenCode 2.2.3 ${placement}: routed roots, MCP, children, cancel, cleanup and resume`, async () => {
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
        "writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,ppid:process.ppid,child:child.pid,cwd:process.cwd(),executable:process.execPath})); console.log('TOOL_READY');setTimeout(()=>{},300000); }",
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
      expect(f.installation.version).toMatch(/^(?:opencode\s+)?v?2\.2\.3$/u);
      // Independent processes start sequentially to avoid the separately documented cold DB race.
      const [a, b] = placement === "auto" ? await Promise.all([open("A"), open("B", { model: "aimock/aimock-other" })]) : [await open("A"), await open("B", { model: "aimock/aimock-other" })];
      expect(runtimes).toHaveLength(placement === "auto" ? 1 : 2);
      for (const session of [a, b]) {
        expect(session.placement).toBe(placement === "auto" ? "shared" : "isolated");
        expect(session.model()).toMatchObject({ value: session === a ? "aimock/aimock-model" : "aimock/aimock-other" });
      }
      const readings = await Promise.all([a.resources?.(), b.resources?.()]);
      for (const resources of readings) {
        if (process.platform === "win32") { expect(resources).toBeNull(); }
        else { expect(resources?.rss).toBeGreaterThan(0); expect(resources?.scope).toBe(placement === "auto" ? "shared_process" : undefined); }
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
      expect(typeof tool?.parent).toBe("number"); expect(typeof tool?.child).toBe("number");
      const parent = Number(tool?.parent); const child = Number(tool?.child);
      await expect.poll(async () => readFile(path.join(f.home, "A-child.json"), "utf8").catch(() => ""), { timeout: 30_000 }).not.toBe("");
      const childReadyFile = await readFile(path.join(f.home, "A-child.json"), "utf8");
      const childReady = asRecord(JSON.parse(childReadyFile));
      expect(childReady).toMatchObject({ pid: child, ppid: parent });
      expect(alive(parent)).toBe(true); expect(alive(child)).toBe(true);
      await cleanup.sample("before-dispose");
      await a.dispose(); await awaitTurnEnd(a, runningTool.request.seq);
      await cleanup.sample("after-dispose");
      await expect.poll(() => [alive(parent), alive(child)], { timeout: 15_000 }).toEqual([false, false]);
      expect(await promptAndWait(b, "ACP_SHARE_B_afterclose")).toMatchObject({ kind: "ended" });
      expect(a.records().filter(r => r.kind === "response" && r.body.kind === (placement === "auto" ? "released" : "exited"))).toHaveLength(1);
      if (placement === "auto") {
        const fresh = await open("A"); expect(fresh.placement).toBe("isolated"); expect(fresh.id).not.toBe(a.id); await fresh.dispose();
        const alias = path.join(f.home, "alias-a"); await symlink(f.cwds[0] ?? "", alias, "junction");
        const aliased = await open("A", { cwd: alias }); expect(aliased.placement).toBe("isolated");
        expect(spy.mock.calls.at(-1)?.[3]?.cwd).toBe(alias); await aliased.dispose();
        const alternate = path.join(f.home, "A"); await mkdir(alternate, { recursive: true });
        const [lower, upper] = await Promise.all([stat(f.cwds[0] ?? ""), stat(alternate)]);
        const caseAlias = await open("A", { cwd: alternate });
        expect(caseAlias.placement).toBe(lower.dev === upper.dev && lower.ino === upper.ino ? "isolated" : "shared"); await caseAlias.dispose();
      }
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
        const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "opencode-sharing");
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
