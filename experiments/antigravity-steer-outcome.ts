/* oxlint-disable eslint/max-statements, typescript/promise-function-async -- Retain both native RPC outcomes in one ordered local-provider probe. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bounded, killOwnedWorker } from "./antigravity-steer-outcome/support.js";
import { createAcpClient, startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";

const mode = process.argv[2] ?? "refusal";
assert.ok(mode === "refusal" || mode === "worker-exit");
assert.equal(process.platform, "linux", "The owned worker identity probe uses Linux procfs");
const command = process.env.OAR_ANTIGRAVITY_BIN;
assert.ok(command !== undefined);
const directory = path.resolve(process.argv[3] ?? "oar-trial-run/antigravity-steer-outcome");
await mkdir(directory, { recursive: true });
const model = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
const fixture = await startAntigravityAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    if (JSON.stringify(request.messages).includes("You are a conversation title generator")) { return { content: "Probe" }; }
    model.resolve(); await release.promise;
    return { content: "AGY_ORIGINAL_COMPLETED" };
  });
});
const home = fixture.env.HOME;
assert.ok(home !== undefined);
const wire: unknown[] = [];
const app = createAcpClient({ name: "oar-steer-outcome" }).onNotification("session/update", () => {});
const native = startAcpProcess(command, ["acp", "--dangerously-skip-permissions", "--process-per-session"], app, {
  cwd: home, env: { ...process.env, ...fixture.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  incoming: message => { wire.push({ direction: "in", message }); return message; },
  outgoing: message => { wire.push({ direction: "out", message }); },
});
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(native, method, 30_000,
  options => native.connection.agent.request(method, params, options))) ?? {};
async function settled(promise: Promise<JsonRecord>): Promise<unknown> {
  try { return { result: await promise }; }
  catch (error) { const value = asRecord(error); return { error: { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error), code: value?.code, data: value?.data } }; }
}
try {
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar", version: "0.0.0" } });
  const opened = await request("session/new", { cwd: home, mcpServers: [] });
  const { sessionId } = opened;
  assert.ok(typeof sessionId === "string");
  const original = settled(request("session/prompt", { sessionId, prompt: [{ type: "text", text: "AGY_ORIGINAL_OUTCOME" }] }));
  await bounded(model.promise);
  const steering = settled(request("session/prompt", { sessionId, prompt: mode === "refusal" ? [{ type: "image", mimeType: "image/png", data: "" }] : [{ type: "text", text: "AGY_ACCEPTED_STEER" }] }));
  let workerCount = 0;
  if (mode === "worker-exit") {
    await bounded(original);
    assert.ok(native.pid !== undefined);
    killOwnedWorker(native.pid); workerCount = 1;
  }
  const steerOutcome = await bounded(steering);
  release.resolve();
  const originalOutcome = await original;
  const result = { mode, initialized: initialized.agentInfo, originalOutcome, steerOutcome, workerCount, rootClosed: native.closed };
  await writeFile(path.join(directory, `${mode}.json`), JSON.stringify({ ...result, wire }, null, 2));
  console.log(JSON.stringify(result));
} finally { release.resolve(); native.kill(); await native.exited; await fixture.stop(); }
