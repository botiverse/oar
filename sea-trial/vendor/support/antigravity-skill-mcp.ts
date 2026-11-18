/* oxlint-disable no-await-in-loop -- Sequential native startup controls own one marker. */
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AvailableInstallation } from "../../../packages/oar/src/contracts/installation.js";
import { antigravityRuntime } from "../../../packages/oar/src/runtimes/antigravity/index.js";
import { runExecutable } from "../../../packages/oar/src/shared/executable/index.js";

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
/** A local JSON-RPC server with a start marker; no Raft configuration or credential. */
export async function antigravitySkillMcpControl(installation: AvailableInstallation & { via: "executable" }, home: string, cwd: string, nativeEnv: NodeJS.ProcessEnv, env: Record<string, string | null>): Promise<unknown[]> {
  const script = join(home, "mcp.cjs");
  const marker = join(home, "mcp-started");
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(process.argv[2],'started');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const q=JSON.parse(line);if(q.id===undefined)return;
const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic-marker',version:'1'}}:q.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});\n`);
  const observations: unknown[] = [];
  for (const scope of ["workspace", "global"]) {
    const config = scope === "workspace" ? join(cwd, ".agents/mcp_config.json") : join(home, ".gemini/config/mcp_config.json");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({ mcpServers: { marker: { command: process.execPath, args: [script, marker] } } }));
    await rm(marker, { force: true });
    const native = await runExecutable(installation.command, ["--output-format", "json", "--print=/skills"], { cwd, env: nativeEnv });
    assert.ok(native.ok, JSON.stringify(native));
    const nativeStarted = await exists(marker);
    assert.equal(nativeStarted, scope === "global");
    await rm(marker, { force: true });
    const files = await antigravityRuntime.skills(installation, { cwd, env });
    assert.equal(files.kind, "ok");
    const fileStarted = await exists(marker);
    assert.equal(fileStarted, false);
    observations.push({ case: "mcp-start", scope, nativeStarted, fileStarted });
    await rm(config);
  }
  return observations;
}
