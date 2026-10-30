/** Synthetic MCP identities and invocation evidence, never real credentials. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "../../packages/oar/src/shared/json.js";

export interface McpInvocation {
  readonly server: string;
  readonly input: string;
  readonly output: string;
}

export interface ScopedMcp {
  readonly script: string;
  readonly calls: () => Promise<McpInvocation[]>;
}

export async function scopedMcp(home: string): Promise<ScopedMcp> {
  const script = path.join(home, "scope-mcp.cjs");
  const journal = path.join(home, "scope-mcp-calls.jsonl");
  await writeFile(journal, "", { mode: 0o600 });
  await writeFile(script, [
    "const {appendFileSync}=require('node:fs');",
    `const journal=${JSON.stringify(journal)};`,
    "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};",
    "if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'scope',version:'1'}};",
    "if(q.method==='tools/list')result={tools:[{name:'echo',description:'Return the configured marker',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};",
    "if(q.method==='tools/call'){const server=process.argv[2],input=q.params.arguments.text,output='MCP_RESULT='+server+' input='+input;",
    String.raw`appendFileSync(journal,JSON.stringify({server,input,output})+'\n');result={content:[{type:'text',text:output}]};}`,
    String.raw`process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');});`,
  ].join("\n"), { mode: 0o600 });
  return { script, calls: async () => { const text = await readFile(journal, "utf8"); return text.split("\n").filter(Boolean).map((line) => {
    const row = asRecord(JSON.parse(line));
    assert.ok(typeof row?.server === "string" && typeof row.input === "string" && typeof row.output === "string", "malformed MCP invocation evidence");
    return { server: row.server, input: row.input, output: row.output };
  }); } };
}

/** Old successful calls cannot mask a later call routed to the wrong server. */
export function invocationEvidence(calls: readonly McpInvocation[], input: string, server: string): {
  readonly input: string; readonly expectedServer: string; readonly calls: readonly McpInvocation[]; readonly isolated: boolean;
} {
  const matching = calls.filter((call) => call.input === input);
  return { input, expectedServer: server, calls: matching,
    isolated: matching.length === 1 && matching[0]?.server === server && matching[0].output === `MCP_RESULT=${server} input=${input}` };
}
