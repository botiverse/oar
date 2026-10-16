/**
 * Follow-up to #399 for runtimes that put MCP tools in a catalog rather
 * than the provider's tools array. Uses real Antigravity or OpenCode v2,
 * a local scripted provider and a fresh home, with no account or model quota.
 *
 * OAR_ANTIGRAVITY_BIN=/path/to/agy_acp_server.par pnpm tsx experiments/mcp-tools-catalog-changed.ts antigravity
 * OAR_OPENCODE_BIN=/path/to/opencode pnpm tsx experiments/mcp-tools-catalog-changed.ts opencode
 * Optional OAR_MCP_PROBE_CAPTURE writes the raw provider bodies locally;
 * they contain temporary paths and native instructions, not credentials.
 *
 * A warmup starts native MCP discovery. After it settles, one round calls
 * alpha. setTools replaces alpha with beta, another round calls beta, and
 * a final round deliberately calls removed alpha.
 *
 * Observed 2026-10-16: OpenCode 2.0.30 relists, announces beta and
 * withdraws alpha in a system update. Only the initial alpha and the later
 * beta reach the handlers. Antigravity 1.4.0 was observed on 2026-10-14.
 *
 * Catalog evidence and handler calls are separate: executing an unlisted tool does not prove
 * that the model was offered it. The loopback proxy supplies only the
 * ephemeral test server's bearer token, never a credential to Antigravity.
 */
/* oxlint-disable eslint/no-await-in-loop -- Deliberately ordered native turns and bounded discovery polling. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, serveMcpTools, type HostTool } from "../packages/oar/src/index.js";
import { asRecord, asRecordList } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import type { LLMock, RawProviderRequest } from "../sea-trial/harness/aimock.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";
import { currentTurnSays } from "../sea-trial/vendor/support/echo-mcp.js";
import { loggingProxy } from "../sea-trial/vendor/support/tools-list-changed.js";

const [id] = process.argv.slice(2);
assert.ok(id === "antigravity" || id === "opencode", "Choose antigravity or OpenCode v2 (opencode)");
const ALPHA = "oar_probe_alpha";
const BETA = "oar_probe_beta";
const calls: string[] = [];
const tool = (name: string): HostTool => ({
  name,
  description: `Probe tool ${name}.`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: () => { calls.push(name); return `HANDLER_RESULT:${name}`; },
});

const rounds = [
  { label: "ALPHA_ROUND", name: ALPHA },
  { label: "BETA_ROUND", name: BETA },
  { label: "REMOVED_ROUND", name: ALPHA },
];
function script(mock: LLMock): void {
  for (const round of rounds) {
    const callId = `call_${round.label}`;
    const call = id === "antigravity"
      ? { name: "call_mcp_tool", arguments: { ServerName: "probe", ToolName: round.name, Arguments: {}, toolSummary: "Call the probe tool", toolAction: "Probing" } }
      : { name: "execute", arguments: { code: `return await tools.probe.${round.name}({});` } };
    mock.on({ predicate: currentTurnSays(new RegExp(round.label, "u")), hasToolResult: false }, {
      toolCalls: [{ id: callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
    });
    mock.on({ hasToolResult: true, toolCallId: callId }, { content: `${round.label}_DONE` });
  }
  mock.onMessage(/[\s\S]*/u, { content: "ok" });
}

/** Keep catalogs separate from history containing old calls and outputs. */
function evidence(request: RawProviderRequest): object {
  const body = asRecord(request.body) ?? {};
  const gemini = asRecordList(asRecord(body.systemInstruction)?.parts)
    .flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n");
  const mcpCatalog = /<mcp_servers>[\s\S]*?<\/mcp_servers>/u.exec(gemini)?.[0] ?? "";
  const system = asRecordList(body.system).flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n");
  const updates = asRecordList(body.messages).flatMap((message) => asRecordList(message.content)
    .flatMap((part) => typeof part.text === "string" && part.text.includes("<system-update>") ? [part.text] : []));
  const catalogLines = (text: string): readonly string[] => text.split("\n")
    .filter((line) => line.includes(ALPHA) || line.includes(BETA));
  return {
    defined: [ALPHA, BETA].filter((name) => JSON.stringify(body.tools ?? []).includes(name)),
    geminiCatalog: catalogLines(mcpCatalog),
    codeModeCatalog: catalogLines(system),
    codeModeUpdates: updates.filter((text) => text.includes(ALPHA) || text.includes(BETA)),
  };
}

const served = await serveMcpTools({ name: "probe", tools: [tool(ALPHA)] });
const env = await (id === "antigravity" ? startAntigravityAimock(script) : startOpencodeAimock(script));
const log: string[] = [];
const proxy = await loggingProxy(served, log);
try {
  const runtime = allRuntimes.require(id);
  const installation = await runtime.installation?.();
  assert.ok(installation?.kind === "available", JSON.stringify(installation));
  const session = await runtime.session(installation, {
    cwd: env.env.HOME ?? process.cwd(), env: env.env,
    mcpServers: [{ name: "probe", type: "http", url: proxy.url }],
  });
  const observations: object[] = [];
  try {
    const run = async (label: string): Promise<void> => {
      const from = env.raw.length;
      const beforeCalls = calls.length;
      const prompt = await session.prompt(label);
      const outcome = await awaitTurnEnd(session, prompt.request.seq);
      assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
      observations.push({ label, outcome: outcome.kind, calls: calls.slice(beforeCalls), requests: env.raw.slice(from).map((request) => evidence(request)) });
    };
    await run("WARMUP");
    const deadline = Date.now() + 10_000;
    while (!log.includes("tools/list") && Date.now() < deadline) { await delay(25); }
    assert.ok(log.includes("tools/list"), "Native MCP discovery did not list tools");
    await delay(3000);
    await run("ALPHA_ROUND");
    log.push("== setTools ==");
    served.setTools([tool(BETA)]);
    await delay(3000);
    await run("BETA_ROUND");
    await run("REMOVED_ROUND");
    assert.deepEqual(calls, [ALPHA, BETA], "Only alpha before replacement and beta after replacement may reach the handlers");
    const serialized = JSON.stringify(session.records());
    const token = served.server.headers?.Authorization?.slice("Bearer ".length);
    assert.ok(token !== undefined && !serialized.includes(token), "Probe token entered the records");
    if (process.env.OAR_MCP_PROBE_CAPTURE !== undefined) {
      await writeFile(process.env.OAR_MCP_PROBE_CAPTURE, JSON.stringify({ observations, server: log, raw: env.raw, records: session.records() }, null, 2));
    }
    console.log(JSON.stringify({ runtime: id, version: installation.via === "executable" ? installation.version : undefined, observations, calls, server: log }, null, 2));
  } finally {
    await session.dispose();
  }
} finally {
  await proxy.close();
  await served.close();
  await env.stop();
}
