/** Compare the cwd inherited by real user/project hook commands, without stdio MCP. */
/* oxlint-disable no-await-in-loop -- Keep each isolated configuration and native process pair independent. */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { experimentalGrokRuntime } from "./grok-candidate.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpFixture } from "./acp-fixture.js";
import { directoryConfiguration } from "./directory-configuration.js";
import { preservingProbeEvidence, probeErrorText } from "./fixture-lifetime.js";

export async function observeGrokHookWorkingDirectory(scope: "user" | "project", placement: "shared" | "isolated"): Promise<JsonRecord> {
    const f = await acpFixture("grok"); const sessions: Session[] = []; const errors: string[] = [];
    let evidence: unknown = null;
    const expected = new Map<string, string>();
    try {
      await preservingProbeEvidence(async () => {
        const [a, b] = f.cwds; assert.ok(a !== undefined && b !== undefined);
        const config = await directoryConfiguration({ runtime: "grok", cwd: a, home: f.home, env: f.provider.env, grokHookScope: scope });
        const script = path.join(f.home, "directory-hook.cjs");
        const source = await readFile(script, "utf8");
        await writeFile(script, source.replace("cwd:process.cwd(),event", "cwd:process.cwd(),environmentMarker:process.env.OAR_EXECUTION_ENV_MARKER??null,event"));
        await config.setRevision("A", a);
        if (scope === "project") { await config.setRevision("B", b); }
        const runtime = experimentalGrokRuntime().withPlacement(placement);
        const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...f.env, OAR_EXECUTION_ENV_MARKER: "oar-execution-fixture",
          PATH: (f.env.PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry)).join(path.delimiter) };
        for (const [index, label] of ["A", "B"].entries()) {
          const cwd = f.cwds[index]; assert.ok(cwd !== undefined);
          const session = await runtime.session(f.installation, { cwd, env }); sessions.push(session); expected.set(session.id, cwd);
          assert.equal(session.placement, placement);
          const outcome = await promptAndWait(session, `ACP_SHARE_${label}_cwd`);
          assert.equal(outcome.kind, "ended");
        }
        evidence = await config.evidence();
        const hooks = asRecord(evidence)?.hooks; assert.ok(Array.isArray(hooks) && hooks.length >= 2, "Missing actual hook invocations");
        const actual = await Promise.all(hooks.map(async hook => {
          const row = asRecord(hook); assert.ok(typeof row?.cwd === "string");
          const owner = expected.get(String(asRecord(row.event)?.sessionId)); assert.ok(owner !== undefined, "Hook must identify its owning session");
          assert.equal(await realpath(row.cwd), await realpath(owner)); assert.equal(row.environmentMarker, "oar-execution-fixture");
          return realpath(row.cwd);
        }));
        const canonical = await Promise.all([realpath(a), realpath(b)]);
        assert.deepEqual([...new Set(actual)].toSorted(), canonical.toSorted(), "Hook cwd must match each session, not the process HOME");
      }, [
        async (): Promise<void> => {
          const results = await Promise.allSettled(sessions.map(async s => { await s.dispose(); }));
          const failed = results.filter(r => r.status === "rejected");
          if (failed.length > 0) { throw new AggregateError(failed.map((r): unknown => r.reason), "Session disposal failed"); }
        },
        async (): Promise<void> => { await f.stop(); },
      ]);
    } catch (error) { errors.push(probeErrorText(error)); }
    const report = { runtime: "grok", version: f.installation.version, platform: process.platform, arch: process.arch, scope, placement,
      processHome: f.env.HOME, sessionCwds: f.cwds, evidence, errors };
    return report;
}
