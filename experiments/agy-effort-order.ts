/** Compare native agy model/effort update order with the provider's actual thinking setting. */
/* oxlint-disable eslint/no-await-in-loop, typescript/promise-function-async -- Native requests and observations are deliberately ordered. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { acpReportedEffort, acpThoughtLevelOption } from "../packages/oar/src/shared/acp/model.js";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";

const command = process.env.OAR_ANTIGRAVITY_BIN;
assert.ok(command !== undefined);
const iterations = Number(process.env.OAR_AGY_ITERATIONS ?? "150");
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const ordered = process.env.OAR_AGY_ORDERED === "1";
const reorderedDelivery = process.env.OAR_AGY_REORDER_DELIVERY === "1";
assert.ok(!(ordered && reorderedDelivery), "the delivery-only counterexample deliberately requires both requests before releasing notifications");
const concurrency = Number(process.env.OAR_AGY_CONCURRENCY ?? "1");
assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 10);
const fixture = await startAntigravityAimock((mock) => { mock.onMessage(/EFFORT_ORDER_PROBE/u, { content: "EFFORT_ORDER_OK" }); });
const home = fixture.env.HOME;
assert.ok(home !== undefined);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"].includes(key)));
const updates = new Map<string, JsonRecord[]>();
const waiters = new Set<() => void>();
const nativeArgs = ["acp", "--disable-telemetry", "--dangerously-skip-permissions", "--process-per-session"];
const relay = fileURLToPath(new URL("antigravity-cli-acp-2026-11-05/reorder-config.mjs", import.meta.url));
const native = startAcpProcess(reorderedDelivery ? process.execPath : command, reorderedDelivery ? [relay, command, ...nativeArgs] : nativeArgs,
  createAcpClient({ name: "oar-effort-order" }).onNotification(methods.client.session.update, () => {}), {
    cwd: home, env: { ...inherited, ...fixture.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    incoming: (message) => {
      const params = asRecord(asRecord(message)?.params), update = asRecord(params?.update);
      if (update?.sessionUpdate === "config_option_update" && typeof params?.sessionId === "string") {
        const list = updates.get(params.sessionId) ?? [];
        list.push(update); updates.set(params.sessionId, list);
        for (const notify of waiters) { notify(); }
      }
      return message;
    },
  });
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(native, method, 30_000,
  (options) => native.connection.agent.request(method, params, options))) ?? {};
async function observed(sessionId: string, count: number): Promise<void> {
  const ready = (): boolean => (updates.get(sessionId)?.length ?? 0) >= count;
  if (ready()) { return; }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const notify = (): void => { if (ready()) { resolve(); } };
  waiters.add(notify);
  const timer = setTimeout(() => { reject(new Error(`Missing config update ${String(count)}`)); }, 5000);
  try { notify(); await promise; } finally { clearTimeout(timer); waiters.delete(notify); }
}
const evidence: unknown[] = [];
try {
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar", version: "0.0.0" } });
  const inspect = async (iteration: number): Promise<void> => {
    const opened = await request("session/new", { cwd: home, mcpServers: [] });
    const { sessionId } = opened;
    assert.ok(typeof sessionId === "string");
    updates.set(sessionId, []);
    const model = await request("session/set_config_option", { sessionId, configId: "model", value: "gemini-3.8-flash" });
    if (ordered) { await observed(sessionId, 1); }
    const configId = acpThoughtLevelOption(model)?.id;
    assert.ok(typeof configId === "string");
    const effort = await request("session/set_config_option", { sessionId, configId, value: "high" });
    await observed(sessionId, 2);
    const seen = (updates.get(sessionId) ?? []).map(update => acpReportedEffort(update));
    let provider: unknown[] | undefined = undefined;
    if (process.env.OAR_AGY_PROVIDER_EACH === "1" || iteration === 0 || seen.at(-1) !== "high") {
      const offset = fixture.raw.length;
      const marker = `EFFORT_ORDER_PROBE_${String(iteration)}`;
      await request("session/prompt", { sessionId, prompt: [{ type: "text", text: marker }] });
      provider = fixture.raw.slice(offset).filter(({ body }) => JSON.stringify(asRecord(body)?.contents).includes(marker) && !JSON.stringify(asRecord(body)?.systemInstruction).includes("You are a conversation title generator"))
        .map(({ body }) => asRecord(asRecord(asRecord(body)?.generationConfig)?.thinkingConfig)?.thinkingLevel);
    }
    evidence.push({ iteration, modelResponse: acpReportedEffort(model), effortResponse: acpReportedEffort(effort), updates: seen, ...(provider === undefined ? {} : { provider }) });
    await request("session/close", { sessionId });
  };
  for (let offset = 0; offset < iterations; offset += concurrency) {
    await Promise.all(Array.from({ length: Math.min(concurrency, iterations - offset) }, async (_, index) => { await inspect(offset + index); }));
  }
  const result = { initialized: initialized.agentInfo, ordered, reorderedDelivery, iterations, concurrency, evidence };
  await writeFile(process.env.OAR_AGY_RESULT ?? "oar-trial-run/agy-effort-order.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { native.kill(); await native.exited; await fixture.stop(); }
