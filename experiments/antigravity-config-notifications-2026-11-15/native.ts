/** Capture native config responses and notifications with an isolated, local provider. */
/* oxlint-disable eslint/no-await-in-loop, typescript/promise-function-async -- The probe deliberately orders native settings. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { createAcpConfigUpdates } from "../../packages/oar/src/shared/acp/config-updates.js";
import { applyAcpModel, applyAcpEffort } from "../../packages/oar/src/shared/acp/effort.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const [binary, output] = process.argv.slice(2);
assert.ok(binary !== undefined && output !== undefined, "usage: native.ts <binary> <output.json>");
const fixture = await startAntigravityAimock(mock => { mock.onMessage(/CONFIG_ATTRIBUTION_PROBE/u, { content: "CONFIG_ATTRIBUTION_OK" }); });
const home = fixture.env.HOME;
assert.ok(home !== undefined);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"].includes(key)));
const observations: unknown[] = [], wire: unknown[] = [];
const updates = createAcpConfigUpdates();
const native = startAcpProcess(resolve(binary), ["acp", "--disable-telemetry", "--dangerously-skip-permissions", "--process-per-session"],
  createAcpClient({ name: "oar-config-attribution" }).onNotification(methods.client.session.update, () => {}), {
    cwd: home, env: { ...inherited, ...fixture.env },
    outgoing: message => { wire.push({ direction: "client", message }); },
    incoming: message => { wire.push({ direction: "agent", message }); updates.observe(asRecord(message)?.params); return message; },
  });
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(native, method, 30_000,
  options => native.connection.agent.request(method, params, options))) ?? {};
const context = { timeoutMs: 30_000, updates, observe: (step: unknown): void => { observations.push(step); } };
let failure: string | null = null;
try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar", version: "0.0.0" } });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const opened = await request("session/new", { cwd: home, mcpServers: [] });
    const { sessionId } = opened;
    assert.equal(typeof sessionId, "string");
    assert.ok(typeof sessionId === "string");
    const response = await applyAcpModel(native, sessionId, "gemini-3.8-flash", { ...context, viaConfigOption: true });
    assert.ok(response);
    await applyAcpEffort(native, { sessionId, response, openMethod: "session/new" }, "high", context);
    const offset = fixture.raw.length;
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: `CONFIG_ATTRIBUTION_PROBE_${String(iteration)}` }] });
    const provider = fixture.raw.slice(offset).filter(({ body }) => JSON.stringify(asRecord(body)?.contents).includes("CONFIG_ATTRIBUTION_PROBE") && !JSON.stringify(asRecord(body)?.systemInstruction).includes("conversation title generator"))
      .map(({ body }) => asRecord(asRecord(asRecord(body)?.generationConfig)?.thinkingConfig)?.thinkingLevel);
    assert.ok(provider.length > 0 && provider.every(level => level === "HIGH"), JSON.stringify(provider));
    observations.push({ iteration, providerThinkingLevels: provider });
    try { await request("session/set_config_option", { sessionId, configId: "thought_level", value: "INVALID_CONFIG_ATTRIBUTION" }); }
    catch (error) { observations.push({ iteration, invalidValue: String(error) }); }
    await request("session/close", { sessionId });
  }
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  native.kill(); await native.exited;
  await writeFile(output, JSON.stringify({ evidenceKind: "unmodified native CLI with local provider", binary, fixtureHome: home, wire, observations, ...(failure === null ? {} : { failure }) }, null, 2));
  await fixture.stop();
}
console.log(JSON.stringify({ output, messages: wire.length, failure: failure ?? null }));
