/**
 * Compare native Antigravity tool-filter namespaces without an account.
 * OAR_ANTIGRAVITY_BIN=/path/to/agy_acp_server.par pnpm tsx experiments/antigravity-tool-filter-meta.ts
 * Keep the matching localharness_external beside the server. Uses a temporary
 * home and local scripted provider; no tool is called and no login is read.
 * The legacy namespace is a diagnostic control, not an OAR fallback.
 * Observed 2026-10-14: 1.3.0 ignores antigravity and only filters with agy;
 * 1.4.0 advertises the antigravity capability and filters with either name.
 */
/* oxlint-disable eslint/no-await-in-loop, typescript/promise-function-async -- Ordered native RPCs; deadline callbacks return SDK promises. */
import assert from "node:assert/strict";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, asRecordList, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";

const command = process.env.OAR_ANTIGRAVITY_BIN;
assert.ok(command !== undefined, "Set OAR_ANTIGRAVITY_BIN to the server under test");
const env = await startAntigravityAimock((mock) => { mock.onMessage(/FILTER_META_OK/u, { content: "FILTER_META_OK" }); });
const nativeHome = env.env.HOME;
assert.ok(nativeHome !== undefined, "the isolated harness must supply HOME");
const app = createAcpClient({ name: "oar-tool-filter-meta" })
  .onNotification(methods.client.session.update, () => {});
const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SystemRoot"].includes(key)));
const native = startAcpProcess(command, process.platform === "linux" ? ["--uid="] : [], app, {
  cwd: nativeHome,
  env: { ...baseEnv, ...env.env },
});
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(native, method, 60_000,
  (options) => native.connection.agent.request(method, params, options))) ?? {};

try {
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar-tool-filter-meta", version: "0.0.0" } });
  const cases: object[] = [];
  for (const namespace of [undefined, "antigravity", "agy"]) {
    const opened = await request("session/new", {
      cwd: nativeHome, mcpServers: [],
      ...(namespace === undefined ? {} : { _meta: { [namespace]: { disabledTools: ["run_command", "view_file"] } } }),
    });
    assert.equal(typeof opened.sessionId, "string", "session/new returned no id");
    const offset = env.raw.length;
    const outcome = await request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "FILTER_META_OK" }] });
    assert.equal(outcome.stopReason, "end_turn");
    const offered = [...new Set(env.raw.slice(offset).flatMap(({ body }) => asRecordList(asRecord(body)?.tools)
      .flatMap((tool) => asRecordList(tool.functionDeclarations).map((declaration) => declaration.name)
        .filter((name): name is string => typeof name === "string"))))].toSorted();
    assert.ok(offered.includes("write_to_file"), "the provider must receive the unrelated built-in tool");
    cases.push({ namespace: namespace ?? "omitted", runCommand: offered.includes("run_command"), viewFile: offered.includes("view_file"), offered });
  }
  console.log(JSON.stringify({ agentInfo: initialized.agentInfo, capabilities: initialized.agentCapabilities, cases }, null, 2));
} finally {
  native.kill();
  await native.exited;
  await env.stop();
}
