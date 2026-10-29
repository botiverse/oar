import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createQwenProviderAuth, QwenProviderAuthError, qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

/** One real turn using a locally supplied Token Plan key. No identity, raw
 * records, key, error message, or native configuration leaves the private HOME. */
const version = "0.26.3";
const providerId = "token-plan";
const region = "ap-southeast-1";
const baseUrl = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const model = "qwen3.7-plus";
const expected = "OAR_QWEN_TOKEN_PLAN_OK";
const report: Record<string, unknown> = {
  probe: "qwen-token-plan-real-2026-10-29", revision: 3,
  platform: process.platform, arch: process.arch, node: process.versions.node,
  providerId, region, baseUrl, model, startedAt: new Date().toISOString(), pass: false,
};
let home: string | null = null;
let session: Session | null = null;
let stage = "arguments";
let output = `qwen-token-plan-${Date.now()}.json`;
let configuredOnly = false;
process.umask(0o077);
process.env.OAR_CHILD_STDERR = "ignore";
try {
  const { values } = parseArgs({ options: {
    binary: { type: "string" }, output: { type: "string" }, "configure-only": { type: "boolean" },
  } });
  output = values.output ?? output;
  configuredOnly = values["configure-only"] === true;
  report.mode = configuredOnly ? "configure_only" : "one_real_turn";
  if (values.binary === undefined || !path.isAbsolute(values.binary)) { throw new Error("absolute binary required"); }
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 24) { throw new Error("Linux Node 24 required"); }
  stage = "key";
  const apiKey = process.env.OAR_QWEN_TOKEN_PLAN_KEY?.trim();
  delete process.env.OAR_QWEN_TOKEN_PLAN_KEY;
  if (apiKey === undefined || apiKey.length === 0) { throw new Error("local key required"); }
  stage = "isolation";
  home = await mkdtemp(path.join(tmpdir(), "oar-qwen-token-plan-"));
  const cwd = path.join(home, "workspace");
  await mkdir(cwd);
  const env: Record<string, string | null> = Object.fromEntries(Object.keys(process.env).map((name) => [name, null]));
  for (const name of ["PATH", "SystemRoot", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"]) {
    if (process.env[name] !== undefined) { env[name] = process.env[name]; }
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, QWEN_HOME: path.join(home, ".qwen"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share"), TMPDIR: home,
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, "system.json"),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(home, "defaults.json"),
    QWEN_CODE_TELEMETRY_ENABLED: "false", OAR_QWEN_BIN: values.binary, OAR_CHILD_STDERR: "ignore",
  });
  stage = "installation";
  const installation = await qwenRuntime.installation({ env });
  report.runtimeAvailable = installation.kind === "available";
  if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("runtime unavailable"); }
  report.versionMatches = installation.version === version;
  if (installation.version !== version) { throw new Error("wrong version"); }
  report.version = version;
  stage = "authStatus_before";
  const before = await qwenRuntime.authStatus(installation, { env });
  report.authStatusBefore = before.kind;
  if (before.kind !== "logged_out") { throw new Error("isolation not confirmed"); }
  stage = "providers";
  const auth = await createQwenProviderAuth(installation, { cwd, env, timeoutMs: 45_000 });
  const providers = await auth.listProviders();
  const provider = providers.find((entry) => entry.id === providerId && entry.protocol === "openai");
  const regions: unknown[] = Array.isArray(provider?.baseUrl) ? provider.baseUrl : [];
  const regionFound = regions.some((entry) => typeof entry === "object" && entry !== null
    && "id" in entry && entry.id === region && "url" in entry && entry.url === baseUrl);
  report.providerFound = provider !== undefined;
  report.endpointMatchesNativeCatalog = regionFound;
  report.modelInProviderDefaults = Array.isArray(provider?.defaultModelIds) && provider.defaultModelIds.includes(model);
  if (provider === undefined || !regionFound || report.modelInProviderDefaults !== true) { throw new Error("catalog mismatch"); }
  stage = "connect";
  const connected = await auth.connect({ providerId, apiKey, baseUrl, modelIds: [model], scope: "user" });
  report.connect = { success: connected.success, providerMatches: connected.providerId === providerId,
    endpointMatches: connected.baseUrl === undefined ? null : connected.baseUrl === baseUrl, modelMatches: connected.modelId === model, openai: connected.authType === "openai" };
  if (connected.providerId !== providerId || (connected.baseUrl !== undefined && connected.baseUrl !== baseUrl) || connected.modelId !== model || connected.authType !== "openai") { throw new Error("configuration mismatch"); }
  stage = "configuration_readback";
  const configuredProviders = await auth.listProviders();
  const persisted = configuredProviders.find((entry) => entry.id === providerId)?.existingConfig;
  report.persisted = { keyPresent: persisted?.hasApiKey === true, endpointMatches: persisted?.baseUrl === baseUrl,
    modelPresent: Array.isArray(persisted?.modelIds) && persisted.modelIds.includes(model) };
  if (persisted?.hasApiKey !== true || persisted.baseUrl !== baseUrl
    || !Array.isArray(persisted.modelIds) || !persisted.modelIds.includes(model)) { throw new Error("persistence mismatch"); }
  stage = "authStatus_after";
  const after = await qwenRuntime.authStatus(installation, { env });
  report.authStatusAfter = after.kind;
  report.authStatusMeaning = "local credential presence only; remote validity is not inferred";
  if (after.kind !== "unknown") { throw new Error("credential presence not observed"); }
  stage = "listModels";
  const catalog = await qwenRuntime.listModels(installation, { cwd, env, timeoutMs: 45_000 });
  report.models = { available: catalog.kind === "ok", count: catalog.kind === "ok" ? catalog.models.length : null,
    selectedPresent: catalog.kind === "ok" && catalog.models.some((entry) => entry.id === model) };
  if (catalog.kind !== "ok" || !catalog.models.some((entry) => entry.id === model)) { throw new Error("model absent"); }
  report.configurationVerified = true;
  if (!configuredOnly) {
    stage = "open";
    session = await qwenRuntime.session(installation, { cwd, env, model });
    stage = "prompt";
    const run = await promptAndWait(session, `Reply with exactly ${expected}. Do not use any tools.`, { timeoutMs: 120_000 });
    const text = "text" in run ? run.text : "";
    const trimmed = text.trim();
    const equalAfterFinalPeriod = trimmed.replace(/[.。]$/u, "").trim() === expected;
    const events = session.records().flatMap((record) => record.kind === "frame" && record.agentPath.length === 0 ? record.body.events : []);
    report.textChecks = { length: text.length, containsMarker: text.includes(expected),
      equalsAfterTrim: trimmed === expected, equalsAfterTrimAndFinalPeriod: equalAfterFinalPeriod,
      equalsMarkerTwice: trimmed === expected + expected,
      reasoningEventCount: events.filter((event) => event.kind === "reasoning").length,
      reasoningCharacterCount: events.reduce((sum, event) => sum + (event.kind === "reasoning" && event.content.kind === "text" ? event.content.text.length : 0), 0),
      messageEventCount: events.filter((event) => event.kind === "text_delta").length };
    report.turn = { ended: run.kind === "ended", completed: run.kind === "ended" && run.outcome.kind === "completed",
      expectedText: run.kind === "ended" && (trimmed === expected || equalAfterFinalPeriod) };
    const totals = session.usage().value.total;
    const usageFields: readonly (keyof NonNullable<typeof totals>)[] = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
    report.usage = totals === null ? null : Object.fromEntries(
      usageFields.flatMap((name) => {
        const value = totals[name];
        return typeof value === "number" && Number.isFinite(value) ? [[name, value]] : [];
      }),
    );
    if (run.kind !== "ended" || run.outcome.kind !== "completed" || !(trimmed === expected || equalAfterFinalPeriod)) { throw new Error("turn unverified"); }
    report.pass = true;
  }
} catch (error) {
  report.failedStage = stage;
  report.failureKind = error instanceof QwenProviderAuthError ? error.kind : "verification_failed";
  // Do not copy error.name/message/code/cause, raw output or any model text.
} finally {
  delete process.env.OAR_QWEN_TOKEN_PLAN_KEY;
  try { await session?.dispose(); report.processCleanup = true; }
  catch { report.processCleanup = false; report.pass = false; }
  try { if (home !== null) { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } report.privateHomeRemoved = true; }
  catch { report.privateHomeRemoved = false; report.pass = false; }
  report.finishedAt = new Date().toISOString();
  try {
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const complete = report.processCleanup === true && report.privateHomeRemoved === true
      && (configuredOnly ? report.configurationVerified === true && report.failedStage === undefined : report.pass === true);
    const success = configuredOnly ? "CONFIGURATION_VERIFIED; no real turn performed. Report saved." : "PASS; report saved.";
    console.log(complete ? success : "NOT_VERIFIED; report saved.");
    process.exitCode = complete ? 0 : 1;
  } catch { console.error("Could not create the private report file."); process.exitCode = 1; }
}
