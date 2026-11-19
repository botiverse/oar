/** Probe full-history forking with an isolated OpenCode binary and a local provider. */
import assert from "node:assert/strict";
import path from "node:path";
import { awaitTurnEnd, opencodeRuntime } from "../../packages/oar/src/index.js";
import { createAcpClient, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

const [binary] = process.argv.slice(2);
assert.ok(binary !== undefined, "Pass the OpenCode executable");
const requests: string[] = [];
const fixture = await startOpencodeAimock(mock => {
  mock.clearFixtures().on({ predicate: () => true }, request => {
    if ((request.tools?.length ?? 0) > 0) { requests.push(JSON.stringify(request.messages)); }
    return { content: "ACK" };
  });
}, { enabled_providers: ["aimock"] });
const cwd = fixture.env.HOME;
assert.ok(cwd !== undefined);
const native = startAcpProcess(path.resolve(binary), ["acp"], createAcpClient({ name: "oar" })
  .onNotification("session/update", () => {}), { cwd, env: fixture.env });
async function rpc(method: string, params: JsonRecord): Promise<JsonRecord> {
  const value = await withAcpDeadline(native, method, 30_000, async options => {
    const reply = await native.connection.agent.request(method, params, options);
    return reply;
  });
  return asRecord(value) ?? {};
}
async function turn(sessionId: string, text: string): Promise<string> {
  const before = requests.length;
  const response = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  assert.equal(response.stopReason, "end_turn");
  assert.ok(requests.length > before);
  return requests.at(-1) ?? "";
}
async function adapterFork(command: string, directory: string, source: string): Promise<void> {
  const session = await opencodeRuntime.session({ kind: "available", via: "executable", command }, {
    cwd: directory, env: fixture.env, resume: source, fork: {}, model: "aimock/aimock-model",
  });
  try {
    assert.notEqual(session.id, source);
    const accepted = await session.prompt("ONLY_ON_ADAPTER_COPY");
    assert.ok(accepted.kind === "accepted");
    const outcome = await awaitTurnEnd(session, accepted.seq);
    assert.equal(outcome.kind, "completed");
    const history = requests.at(-1) ?? "";
    assert.ok(history.includes("SOURCE_ALPHA") && history.includes("SOURCE_BRAVO") && !history.includes("ONLY_ON_COPY"));
    assert.ok(session.records().some(record => record.kind === "frame" && record.body.type === "session/fork" && record.sessionId === session.id));
  } finally { await session.dispose(); }
}

try {
  const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const fork = asRecord(asRecord(init.agentCapabilities)?.sessionCapabilities)?.fork;
  assert.ok(fork === true || asRecord(fork) !== null);
  const params = { cwd, mcpServers: [] };
  const opened = await rpc("session/new", params);
  const source = opened.sessionId;
  assert.ok(typeof source === "string");
  await rpc("session/set_config_option", { sessionId: source, configId: "model", value: "aimock/aimock-model" });
  await turn(source, "SOURCE_ALPHA");
  await turn(source, "SOURCE_BRAVO");
  const copy = await rpc("session/fork", { ...params, sessionId: source });
  assert.ok(typeof copy.sessionId === "string" && copy.sessionId !== source);
  const copied = await turn(copy.sessionId, "ONLY_ON_COPY");
  assert.ok(copied.includes("SOURCE_ALPHA") && copied.includes("SOURCE_BRAVO"));
  const original = await turn(source, "ONLY_ON_SOURCE");
  assert.ok(original.includes("SOURCE_BRAVO") && !original.includes("ONLY_ON_COPY"));
  await adapterFork(path.resolve(binary), cwd, source);
  const after = await turn(source, "CHECK_SOURCE_AGAIN");
  assert.ok(!after.includes("ONLY_ON_ADAPTER_COPY"));
  console.log(JSON.stringify({ version: asRecord(init.agentInfo)?.version, fork, responseKeys: Object.keys(copy), differentId: true, inheritedBothTurns: true, sourceUnchanged: true, adapterCopyConfirmed: true }));
} finally { native.kill(); await native.exited; await fixture.stop(); }
