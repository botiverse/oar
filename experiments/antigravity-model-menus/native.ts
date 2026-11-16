/** Query only: native catalogs and per-model menus, without a prompt or real login. */
/* oxlint-disable no-await-in-loop, typescript/promise-function-async -- Native session configuration is sequential. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { antigravityListModels, projectAntigravityModels } from "../../packages/oar/src/runtimes/antigravity/list-models.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const [binary, output] = process.argv.slice(2);
assert.ok(binary !== undefined && output !== undefined);
const fixture = await startAntigravityAimock(() => {});
const cwd = fixture.env.HOME; assert.ok(cwd !== undefined);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"].includes(key))), ...fixture.env };
const settingsPath = resolve(cwd, ".gemini/antigravity-cli/settings.json");
const before = await readFile(settingsPath, "utf8");
const settings: unknown[] = [{ phase: "before", value: asRecord(JSON.parse(before)) }];
const timings: unknown[] = [], wire: unknown[] = [];
const native = startAcpProcess(resolve(binary), ["acp", "--disable-telemetry", "--dangerously-skip-permissions", "--process-per-session"], createAcpClient({ name: "oar-model-menus" }).onNotification(methods.client.session.update, () => {}), {
  cwd, env, outgoing: message => { wire.push({ direction: "client", message }); }, incoming: message => { wire.push({ direction: "agent", message }); return message; },
});
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
  const start = performance.now();
  const result = asRecord(await withAcpDeadline(native, method, 30_000, options => native.connection.agent.request(method, params, options))) ?? {};
  timings.push({ method, model: params.value ?? null, elapsedMs: performance.now() - start });
  const settingsText = await readFile(settingsPath, "utf8");
  settings.push({ phase: method, model: params.value ?? null, value: asRecord(JSON.parse(settingsText)) }); return result;
};
let failure: string | null = null;
const results: JsonRecord = {};
try {
  const version = await runExecutable(resolve(binary), ["--version"], { env, cwd, timeoutMs: 30_000 });
  results.version = version;
  results.cli = await runExecutable(resolve(binary), ["models"], { env, cwd, timeoutMs: 30_000 });
  results.initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar", version: "0.0.0" } });
  const listingStart = performance.now();
  results.oar = await antigravityListModels({ kind: "available", via: "executable", command: resolve(binary), version: version.stdout.trim() }, { env: fixture.env, cwd });
  results.listingElapsedMs = performance.now() - listingStart;
  const afterListing = await readFile(settingsPath, "utf8");
  results.listingSettingsEqual = isDeepStrictEqual(JSON.parse(before), JSON.parse(afterListing));
  assert.equal(results.listingSettingsEqual, true);
  const opened = await request("session/new", { cwd, mcpServers: [] }); results.opened = opened;
  const { sessionId } = opened; assert.ok(typeof sessionId === "string");
  const model = asRecordList(opened.configOptions).find(option => option.id === "model");
  const menus: unknown[] = []; results.menus = menus;
  for (const option of asRecordList(model?.options)) {
    assert.ok(typeof option.value === "string");
    const response = await request("session/set_config_option", { sessionId, configId: "model", value: option.value });
    const actual = projectAntigravityModels(response)?.find(entry => entry.id === option.value)?.effortLevels;
    const projected = projectAntigravityModels(opened)?.find(entry => entry.id === option.value)?.effortLevels;
    assert.deepEqual((actual ?? []).toSorted(), (projected ?? []).toSorted());
    menus.push({ id: option.value, response });
  }
  await request("session/close", { sessionId });
  results.settingsUnchanged = before === await readFile(settingsPath, "utf8");
  assert.equal(fixture.raw.length, 0);
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  native.kill(); await native.exited;
  await writeFile(output, JSON.stringify({ results, timings, settings, wire, providerRequests: fixture.raw.length, failure }, null, 2)); await fixture.stop();
}
console.log(JSON.stringify({ output, failure, requests: timings.length }));
