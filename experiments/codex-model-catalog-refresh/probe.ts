/** Native catalog-only probe. No turn, real credential or inference request. */
/* oxlint-disable import/max-dependencies -- The experiment composes the native client, public adapters and isolated HTTP/file fixtures. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAppServerClient, type AppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { codexListModels } from "../../packages/oar/src/runtimes/codex/list-models.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { codexVersion } from "../../packages/oar/src/runtimes/codex/refusal.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const command = process.env.OAR_CODEX_BIN ?? "";
assert.notEqual(command, "", "set OAR_CODEX_BIN to Codex 0.169.0");
const root = await mkdtemp(path.join(tmpdir(), "oar-catalog-refresh-"));
const output = path.resolve(process.env.OAR_CATALOG_PROBE_OUTPUT ?? "oar-trial-run/catalog-refresh.json");
const clients: AppServerClient[] = [];
const started = performance.now();
const requests: { path: string; scenario: string | null; atMs: number }[] = [];
const results: Record<string, unknown> = { native: "0.169.0", platform: process.platform, requests };
function model(slug: string, display: string): JsonRecord {
  return { slug, display_name: display, description: "Synthetic catalog observation", base_instructions: "Synthetic model. No inference is sent.", supported_reasoning_levels: [{ effort: "low", description: "Fixture" }],
    default_reasoning_level: "low", shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
    support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10_000 }, experimental_supported_tools: [], context_window: 32_000 };
}
const catalog = (slug: string, display: string): JsonRecord => ({ models: [model(slug, display)] });
let remoteCatalog = catalog("probe-remote-a", "Remote A");
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  requests.push({ path: url.pathname, scenario: url.searchParams.get("scenario"), atMs: performance.now() - started });
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/models") { response.end(JSON.stringify(remoteCatalog)); }
  else { response.statusCode = 500; response.end('{"error":"No inference permitted in this probe"}'); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const base = `http://127.0.0.1:${String(address.port)}`;

async function save(): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
}
async function environment(name: string, fixed: boolean, discovery = true): Promise<{ env: Record<string, string | null>; file: string; home: string }> {
  const home = path.join(root, name);
  await mkdir(home, { recursive: true });
  const file = path.join(home, "catalog.json");
  await writeFile(file, JSON.stringify(catalog("probe-fixed-a", "Fixed A")));
  await writeFile(path.join(home, "config.toml"), [
    'model_provider = "catalog_probe"',
    ...(fixed ? [`model_catalog_json = ${JSON.stringify(file)}`] : []),
    '[features]', `api_key_model_discovery = ${String(discovery)}`,
    '[model_providers.catalog_probe]', 'name = "Local catalog probe"',
    `base_url = ${JSON.stringify(`${base}/v1`)}`, `model_catalog_url = ${JSON.stringify(`${base}/models?scenario=${name}`)}`,
    'env_key = "OAR_CATALOG_PROBE_KEY"', 'wire_api = "responses"',
  ].join("\n"));
  const env: Record<string, string | null> = Object.fromEntries(Object.keys(process.env).map(key => [key, null]));
  Object.assign(env, { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, CODEX_HOME: home,
    OAR_CATALOG_PROBE_KEY: "synthetic-catalog-only", NO_COLOR: "1" });
  return { env, file, home };
}
async function launch(env: Record<string, string | null>, cwd: string): Promise<AppServerClient> {
  const client = startAppServerClient(command, env, {}, cwd, { inheritStderr: true });
  clients.push(client);
  client.handle({ onNotification() {}, onServerRequest(id) { client.respond(id, { error: { code: -32_601, message: "No tools in catalog probe" } }); } });
  await client.spawned;
  const initialized = await client.request("initialize", { clientInfo: { name: "oar-catalog-probe", version: "0" }, capabilities: { experimentalApi: true } });
  assert.equal(codexVersion(initialized), "0.169.0", "probe requires the pinned native version");
  client.notify("initialized", {});
  return client;
}
async function picker(client: AppServerClient): Promise<JsonRecord[]> {
  const result = await client.request("model/list", {});
  return asRecordList(result.data).map(row => ({ model: row.model, displayName: row.displayName, isDefault: row.isDefault }));
}
const watchdog = setTimeout(() => { for (const client of clients) { client.kill(); } }, 330_000);
try {
  const fixed = await environment("fixed", true);
  const fixedClient = await launch(fixed.env, fixed.home);
  const initialConfig = await fixedClient.request("config/read", { includeLayers: false });
  results.fixedProvider = asRecord(initialConfig.config)?.model_provider;
  assert.equal(results.fixedProvider, "catalog_probe");
  results.fixedInitial = await picker(fixedClient);
  await save();
  assert.equal(asRecordList(results.fixedInitial)[0]?.model, "probe-fixed-a");
  await writeFile(fixed.file, JSON.stringify(catalog("probe-fixed-b", "Fixed B")));
  results.fixedAfterFileEdit = await picker(fixedClient);
  assert.deepEqual(results.fixedAfterFileEdit, results.fixedInitial);
  results.oarFreshListAfterEdit = await codexListModels({ kind: "available", via: "executable", command }, { env: fixed.env, cwd: fixed.home });
  assert.equal(asRecord(results.oarFreshListAfterEdit)?.kind, "ok");
  assert.equal(asRecordList(asRecord(results.oarFreshListAfterEdit)?.models)[0]?.id, "probe-fixed-b");
  results.fixedHttpRequests = requests.length;
  assert.equal(requests.length, 0);
  const configSession = await codexSession({ kind: "available", via: "executable", command }, { env: fixed.env, cwd: fixed.home });
  try {
    results.oarConfigSessionModel = configSession.model().value;
    assert.equal(results.oarConfigSessionModel, "probe-fixed-b");
  } finally { await configSession.dispose(); }
  const launchOnly = await environment("launch-args", false);
  const launchSession = await codexSession({ kind: "available", via: "executable", command }, {
    env: launchOnly.env, cwd: launchOnly.home,
    launchArgs: ["-c", `model_catalog_json=${JSON.stringify(launchOnly.file)}`],
  });
  try {
    results.oarLaunchArgsSessionModel = launchSession.model().value;
    assert.equal(results.oarLaunchArgsSessionModel, "probe-fixed-a");
  } finally { await launchSession.dispose(); }
  assert.equal(requests.length, 0, "fixed catalog session opens must not fetch the catalog");
  const disabled = await environment("discovery-disabled", false, false);
  const disabledClient = await launch(disabled.env, disabled.home);
  results.apiKeyDiscoveryDisabled = await picker(disabledClient);
  assert.equal(requests.length, 0);
  disabledClient.kill(); await disabledClient.exited;
  const dynamic = await environment("dynamic", false);
  const dynamicClient = await launch(dynamic.env, dynamic.home);
  results.dynamicInitial = await picker(dynamicClient);
  assert.equal(asRecordList(results.dynamicInitial)[0]?.model, "probe-remote-a");
  results.initialHttpCount = requests.length;
  remoteCatalog = catalog("probe-remote-b", "Remote B");
  results.dynamicBeforeRefresh = await picker(dynamicClient);
  assert.deepEqual(results.dynamicBeforeRefresh, results.dynamicInitial);
  await save();
  console.log("initial controls passed; observing the native 270-second refresh interval");
  await delay(276_000);
  results.dynamicAfterIdle = await picker(dynamicClient);
  results.fixedAfterIdle = await picker(fixedClient);
  assert.equal(asRecordList(results.dynamicAfterIdle)[0]?.model, "probe-remote-b");
  assert.deepEqual(results.fixedAfterIdle, results.fixedInitial);
  assert.ok(requests.length > Number(results.initialHttpCount));
  assert.ok(requests.every(request => request.path === "/models" && request.scenario === "dynamic"), "only the dynamic catalog may request the loopback server");
  const currentConfig = await fixedClient.request("config/read", { includeLayers: false });
  results.configCatalogPathStillPresent = typeof asRecord(currentConfig.config)?.model_catalog_json === "string";
  results.elapsedMs = performance.now() - started;
  results.status = "passed";
  await save();
  console.log(`catalog controls passed; ${String(requests.length)} loopback HTTP requests`);
} catch (error) {
  results.status = "failed";
  results.failure = error instanceof Error ? error.message : String(error);
  await save();
  throw error;
} finally {
  clearTimeout(watchdog);
  for (const client of clients) { client.kill(); }
  await Promise.all(clients.map(async client => { await client.exited; }));
  server.close();
  await rm(root, { recursive: true, force: true });
}
