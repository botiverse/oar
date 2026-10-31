/** Record plugin context and an actual child launched by the plugin without cwd/env overrides. */
/* oxlint-disable no-await-in-loop -- Each native session completes its observed tool before the next opens. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpFixture, type AcpFixture } from "./acp-fixture.js";
import { directoryConfiguration } from "./directory-configuration.js";
import { executionMarker, instrumentTool } from "./execution-observations.js";
import { preservingProbeEvidence, probeErrorText } from "./fixture-lifetime.js";

export async function observeOpenCodeHookWorkingDirectory(scope: "user" | "project", placement: "shared" | "isolated"): Promise<JsonRecord> {
  const f = await acpFixture("opencode"); const row: JsonRecord = { runtime: "opencode", version: f.installation.version, platform: process.platform, arch: process.arch,
    scope, placement, processHome: f.env.HOME, sessionCwds: f.cwds, errors: [] };
  const errors: string[] = []; row.errors = errors;
  f.env.OAR_EXECUTION_ENV_MARKER = executionMarker;
  try {
    await preservingProbeEvidence(async () => {
      const [a, b] = f.cwds; assert.ok(a !== undefined && b !== undefined);
      const config = await directoryConfiguration({ runtime: "opencode", cwd: a, home: f.home, env: f.env, opencodeConfigurationScope: scope });
      const collectTools = await instrumentTool(f);
      await config.setRevision("A", a); if (scope === "project") { await config.setRevision("B", b); }
      const roots = scope === "user" ? [path.join(f.env.XDG_CONFIG_HOME ?? "", "opencode")] : [path.join(a, ".opencode"), path.join(b, ".opencode")];
      for (const root of roots) {
        const file = path.join(root, "plugins/directory-observer/index.ts"); const source = await readFile(file, "utf8");
        const child = "console.log(JSON.stringify({cwd:process.cwd(),environmentMarker:process.env.OAR_EXECUTION_ENV_MARKER??null}))";
        await writeFile(file, `import {execFileSync} from "node:child_process";\n${source.replace('event})', `event,cwd:process.cwd(),location:ctx.location.directory,environmentMarker:process.env.OAR_EXECUTION_ENV_MARKER??null,child:JSON.parse(execFileSync(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(child)}],{encoding:'utf8'}))})`)}`);
      }
      let shared: Awaited<ReturnType<AcpFixture["connect"]>> | null = null;
      for (const label of ["A", "B"] as const) {
        const cwd = f.cwds[label === "A" ? 0 : 1]; assert.ok(cwd !== undefined);
        const connection = placement === "shared" ? shared ??= await f.connect({ cwd: f.env.HOME ?? f.home }) : await f.connect({ cwd });
        const session = await f.open(connection, label, { cwd, withMcp: false }); await f.prompt(connection.child, session.id, `${label}_cwd`);
      }
      row.evidence = await config.evidence(); row.tools = await collectTools();
      const hooks = asRecord(row.evidence)?.hooks; assert.ok(Array.isArray(hooks) && hooks.length >= 2, "Missing actual plugin invocations");
      for (const hook of hooks) {
        const value = asRecord(hook); assert.equal(value?.environmentMarker, executionMarker);
        assert.equal(asRecord(value.child)?.environmentMarker, executionMarker);
        assert.ok(typeof asRecord(value.child)?.cwd === "string", "Missing actual hook child cwd");
      }
    }, [async (): Promise<void> => { await f.stop(); }]);
  } catch (error) { errors.push(probeErrorText(error)); }
  return row;
}
