/** Native controls bypass product admission only to observe the behavior that admission rejects. */
/* oxlint-disable no-await-in-loop -- Each session has a complete tool/cwd observation before the next opens. */
import assert from "node:assert/strict";
import { appendFile, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpFixture, type AcpFixture } from "./acp-fixture.js";
import { instrumentTool } from "./execution-observations.js";
import { preservingProbeEvidence, probeErrorText } from "./fixture-lifetime.js";

async function configure(f: AcpFixture): Promise<void> {
  if (f.id === "grok") {
    await appendFile(path.join(f.env.GROK_HOME ?? "", "config.toml"), `\n[mcp_servers.scope]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([f.mcp.script, "configured"])}\n`);
  } else {
    const file = path.join(f.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
    const config = asRecord(JSON.parse(await readFile(file, "utf8"))); assert.ok(config !== null);
    config.mcp = { scope: { type: "local", command: [process.execPath, f.mcp.script, "configured"], enabled: true } };
    await writeFile(file, JSON.stringify(config));
  }
}

export async function observeMcpWorkingDirectory(runtime: "grok" | "opencode", placement: "shared" | "isolated", source: "session" | "user"): Promise<JsonRecord> {
  const errors: string[] = []; const observations: JsonRecord[] = [];
  const row: JsonRecord = { runtime, platform: process.platform, arch: process.arch, placement, source, kind: "native_control", observations, errors };
  const f = await acpFixture(runtime);
  f.env.OAR_EXECUTION_ENV_MARKER = "oar-execution-fixture";
  row.version = f.installation.version; row.processHome = f.env.HOME; row.sessionCwds = f.cwds;
  try {
    await preservingProbeEvidence(async () => {
      if (source === "user") { await configure(f); }
      const collectTools = await instrumentTool(f);
      let shared: Awaited<ReturnType<AcpFixture["connect"]>> | null = null;
      for (const [index, label] of (["A", "B"] as const).entries()) {
        const cwd = f.cwds[index]; assert.ok(cwd !== undefined);
        const connection = placement === "shared" ? shared ??= await f.connect({ cwd: f.env.HOME ?? f.home }) : await f.connect({ cwd });
        const session = await f.open(connection, label, { cwd, withMcp: source === "session" });
        // The first real terminal turn lets OpenCode finish asynchronous MCP discovery.
        await f.prompt(connection.child, session.id, `${label}_cwd`);
        await f.prompt(connection.child, session.id, `${label}_mcp`);
      }
      row.tools = await collectTools();
      const calls = await f.mcp.calls(); row.calls = calls;
      assert.deepEqual(calls.toSorted((a, b) => a.input.localeCompare(b.input)), ["A", "B"].map(label => {
        const server = source === "session" ? label : "configured"; return { server, input: label, output: `MCP_RESULT=${server} input=${label}` };
      }));
    }, [
      async (): Promise<void> => {
        const starts = await f.mcp.starts(); assert.ok(starts.length > 0, "Missing MCP startup evidence");
        const expected = await Promise.all(f.cwds.map(async cwd => { const canonical = await realpath(cwd); return canonical; }));
        for (const start of starts) {
          const cwd = await realpath(start.cwd);
          assert.equal(start.environmentMarker, "oar-execution-fixture", "MCP child must inherit the environment marker");
          observations.push({ ...start, matchesSession: expected.includes(cwd), home: f.env.HOME });
        }
        row.sessionDirectoriesObserved = await Promise.all(expected.map(async cwd => {
          const observed = await Promise.all(starts.map(async s => { const canonical = await realpath(s.cwd); return canonical; })); return observed.includes(cwd);
        }));
      },
      async (): Promise<void> => { await f.stop(); },
    ]);
  } catch (error) { errors.push(probeErrorText(error)); }
  return row;
}
