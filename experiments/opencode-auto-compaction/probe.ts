/** Capture every ACP message around a native v1 automatic compaction and a matched control. */
/* oxlint-disable eslint/no-await-in-loop -- Each turn advances the same native session. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

const [binary, directory, mode] = process.argv.slice(2);
assert.ok(binary !== undefined && directory !== undefined && (mode === "auto" || mode === "control"), "usage: <v1 binary> <new output directory> auto|control");
await mkdir(directory, { mode: 0o700 });
const marker = "OAR_SUMMARY";
const summary = `## Objective\nKeep the synthetic marker ${marker}.\n## Work State\nThe seed turn finished.`;
const provider: { turn: string; kind: string; input: number; sawSummary: boolean }[] = [];
let turn = "setup";
let sentHigh = false;
const fixture = await startOpencodeAimock((mock) => {
  mock.clearFixtures().on({ predicate: () => true }, (request) => {
    const body = JSON.stringify(request.messages);
    const summarizing = body.includes("Output exactly the Markdown structure shown inside <template>");
    const ordinary = (request.tools?.length ?? 0) > 0;
    let kind = "title";
    if (summarizing) { kind = "summary"; }
    else if (ordinary) { kind = "assistant"; }
    const high = kind === "assistant" && turn === "pressure" && !sentHigh;
    sentHigh ||= high;
    const input = high ? 195_000 : 1000;
    let content = "Probe title";
    if (kind === "summary" || turn === "mimic") { content = summary; }
    else if (ordinary) { content = "ACK"; }
    provider.push({ turn, kind, input, sawSummary: body.includes(marker) });
    return { content, usage: { input_tokens: input, output_tokens: 20 } };
  });
}, { compaction: { auto: mode === "auto" }, enabled_providers: ["aimock"] });

const cwd = fixture.env.HOME;
const data = fixture.env.XDG_DATA_HOME;
assert.ok(cwd !== undefined && data !== undefined);
const wire: { turn: string; direction: string; message: unknown }[] = [];
const native = startAcpProcess(path.resolve(binary), ["acp"], createAcpClient({ name: "oar" })
  .onNotification(methods.client.session.update, () => {}), {
  cwd, env: { PATH: process.env.PATH, ...fixture.env },
  incoming: (message) => { wire.push({ turn, direction: "in", message }); return message; },
  outgoing: (message) => { wire.push({ turn, direction: "out", message }); },
});
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
  const value = await withAcpDeadline(native, method, 30_000, async (options) => {
    const result = await native.connection.agent.request(method, params, options);
    return result;
  });
  return asRecord(value) ?? {};
};
try {
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(asRecord(initialized.agentInfo)?.version, "1.19.6");
  const { sessionId } = await request("session/new", { cwd, mcpServers: [] });
  assert.ok(typeof sessionId === "string");
  for (const phase of ["seed", "pressure", "followup", "mimic"]) {
    turn = phase;
    const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: turn }] });
    assert.equal(result.stopReason, "end_turn");
  }
  await delay(1000);
  const db = new DatabaseSync(path.join(data, "opencode", "opencode.db"), { readOnly: true });
  try {
    const parts = db.prepare(`
      SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction'
      ORDER BY time_created`).all(sessionId);
    const summaries = db.prepare(`
      SELECT json_extract(data, '$.finish') AS finish FROM message
      WHERE session_id = ? AND json_extract(data, '$.summary') = 1 ORDER BY time_created`).all(sessionId);
    const database = { parts: parts.map((row) => parseJson(String(row.data))), summaries };
    await writeFile(path.join(directory, "database.json"), JSON.stringify(database, null, 2));
    assert.deepEqual(database.parts.map((part) => asRecord(part)?.auto), mode === "auto" ? [true] : []);
    assert.deepEqual(summaries.map((row) => row.finish), mode === "auto" ? ["stop"] : []);
    assert.equal(provider.filter((row) => row.kind === "summary").length, parts.length);
    assert.equal(provider.find((row) => row.turn === "followup" && row.kind === "assistant")?.sawSummary, mode === "auto");
  } finally { db.close(); }
} finally {
  native.kill();
  await native.exited;
  try {
    await writeFile(path.join(directory, "raw.json"), JSON.stringify({ wire, provider, requests: fixture.raw.map(({ body }) => body) }, null, 2));
  } finally { await fixture.stop(); }
}
