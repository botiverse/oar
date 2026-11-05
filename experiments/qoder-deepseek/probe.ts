/* oxlint-disable import/max-dependencies -- Manual native credentials, filesystem evidence, public sessions and a private control transport. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { qoderSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { nativeControl, NativeFailureError } from "./native-control.js";

type Facts = Record<string, unknown>;
async function turn(session: Session, input: string): Promise<{ text: string }> {
  const release = setTimeout(() => { void session.dispose(); }, 105_000);
  try {
    const result = await promptAndWait(session, input, { timeoutMs: 90_000 });
    assert.equal(result.kind, "ended");
    assert.equal(result.outcome.kind, "completed");
    return result;
  } finally { clearTimeout(release); }
}
function results(session: Session): Facts[] {
  return session.records().flatMap(record => {
    if (record.kind !== "frame") { return []; }
    const native = asRecord(record.body.native);
    return native?.type === "result" ? [{ seq: record.seq, type: native.type, subtype: native.subtype, isError: native.is_error }] : [];
  });
}
const command = process.env.QODER_PROBE_COMMAND;
assert.ok(command !== undefined && command.length > 0, "Set QODER_PROBE_COMMAND to the installed native executable.");
const run = process.argv.includes("--run");
const secret = process.env.DEEPSEEK_API_KEY;
if (run) { assert.ok(secret !== undefined && secret.length > 0, "DEEPSEEK_API_KEY must be injected privately before --run."); }
const native = nativeControl(command);
const checks: Facts[] = [];
const report: Facts = { platform: `${process.platform}-${process.arch}`, mode: run ? "real-inference" : "read-only", submittedPrompts: 0, configurationCreated: false, checks };
const key = `oar-deepseek-probe/${randomUUID()}`;
let configAttempted = false;
let session: Session | null = null;
let cwd: string | null = null;
let stage = "initialize";
try {
  const init = await native.initialize();
  const version = init.daemon_version;
  assert.equal(version, "1.1.83", "Review the no-key access check before probing a different native version.");
  report.version = version;
  stage = "catalog";
  const catalog = await native.request("daemon.get_byok_config");
  const provider = asRecordList(catalog.providers).find(row => row.key === "deepseek");
  report.deepseek = provider === undefined ? null : { provider: provider.key, enabled: provider.enabled !== false,
    types: asRecordList(provider.types).map(group => ({ type: group.key,
      models: asRecordList(group.models).map(model => ({ key: model.key, displayName: model.display_name, format: model.format })) })) };
  assert.ok(provider !== undefined && provider.enabled !== false, "DeepSeek must appear in the current native provider catalog.");
  assert.ok(asRecordList(provider.types).some(group => group.key === "pg" && asRecordList(group.models).some(model => model.key === "deepseek-flash-pg")), "Requested model must be in the native catalog.");
  stage = "access";
  const access = await native.request("daemon.check_byok_config", { config: { provider: "deepseek", model: "deepseek-flash-pg", type: "pg", parameters: {} } });
  report.emptyParametersCheck = { success: access.success, code: access.code, emptyParameters: access.error === "parameters must not be empty" };
  // In 1.1.83 this error follows the native account-access guard and precedes
  // its provider check. It neither sends a provider key nor performs inference.
  assert.equal(access.code, "BYOK_CONFIG_INVALID");
  assert.equal(access.error, "parameters must not be empty");
  if (run) {
    const config = { key, provider: "deepseek", model: "deepseek-flash-pg", type: "pg", parameters: { api_key: secret } };
    stage = "validate";
    const check = await native.request("daemon.check_byok_config", { config });
    report.keyValidation = { success: check.success, code: check.code };
    assert.equal(check.success, true, "Native credential validation must pass.");
    stage = "create";
    const before = await native.request("daemon.list_byok_configs");
    assert.ok(!asRecordList(before.configs).some(item => item.key === key));
    configAttempted = true;
    const created = await native.request("daemon.create_byok_config", { config });
    assert.equal(asRecord(created.config)?.key, key);
    report.configurationCreated = true;
    cwd = await mkdtemp(path.join(tmpdir(), "oar-qoder-deepseek-"));
    const marker = `oar-history-${randomUUID()}`;
    const fileValue = `tool-value-${randomUUID()}\n`;
    await writeFile(path.join(cwd, "probe.txt"), fileValue, { mode: 0o600 });
    const options = { cwd, model: key, env: { DEEPSEEK_API_KEY: null }, disallowedTools: ["Bash", "WebFetch", "WebSearch", "Task"] };
    const installation = { kind: "available" as const, via: "executable" as const, command, version };
    stage = "inference";
    session = await qoderSession(installation, options);
    report.selectedModel = session.model().value;
    report.submittedPrompts = 1;
    const first = await turn(session, `Remember this marker for our next turns: ${marker}. Reply exactly READY followed by that marker. Do not use tools.`);
    assert.ok(first.text.includes(marker));
    checks.push({ name: "inference", passed: true });
    stage = "tools";
    const afterSeq = session.records().at(-1)?.seq ?? -1;
    report.submittedPrompts = 2;
    await turn(session, "Use the file read and file write tools to copy the exact contents of probe.txt into copied.txt in the current directory. Do not use shell or network tools. Reply COPIED when done.");
    assert.equal(await readFile(path.join(cwd, "copied.txt"), "utf8"), fileValue);
    const events = session.records().flatMap(record => record.seq > afterSeq && record.kind === "frame" ? record.body.events : []);
    const started = events.filter(event => event.kind === "tool_call_started");
    const ended = events.filter(event => event.kind === "tool_call_ended");
    assert.ok(started.length >= 2 && ended.length >= 2, "Native tool records must accompany the actual file result.");
    checks.push({ name: "read-write-tools", passed: true, tools: started.map(event => event.tool), started: started.length, ended: ended.length });
    report.firstOpenUsage = session.usage().value.total;
    report.firstOpenNativeResults = results(session);
    const { id } = session;
    await session.dispose(); session = null;
    await rm(path.join(cwd, "probe.txt"));
    await rm(path.join(cwd, "copied.txt"));
    stage = "resume";
    session = await qoderSession(installation, { ...options, resume: id });
    assert.equal(session.id, id);
    report.submittedPrompts = 3;
    const resumed = await turn(session, "Without using any tools, return only the exact marker I asked you to remember at the beginning of this conversation.");
    assert.ok(resumed.text.includes(marker));
    checks.push({ name: "cross-process-resume", passed: true });
    report.resumedOpenUsage = session.usage().value.total;
    report.resumedOpenNativeResults = results(session);
  }
} catch (error) {
  let code = "ERROR";
  if (error instanceof NativeFailureError) { ({ code } = error); } else if (error instanceof Error) { code = error.name; }
  report.failure = { stage, code };
  process.exitCode = 1;
} finally {
  if (session !== null) { await session.dispose().catch(() => { report.sessionCleanupFailed = true; process.exitCode = 1; }); }
  if (configAttempted) {
    try {
      const configs = await native.request("daemon.list_byok_configs");
      if (asRecordList(configs.configs).some(item => item.key === key)) { await native.request("daemon.delete_byok_config", { target: { key } }); }
      const after = await native.request("daemon.list_byok_configs");
      const removed = !asRecordList(after.configs).some(item => item.key === key);
      report.configurationRemoved = removed;
      if (!removed) { process.exitCode = 1; }
    } catch { report.configurationRemoved = false; process.exitCode = 1; }
  }
  if (cwd !== null) { await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => { report.directoryCleanupFailed = true; process.exitCode = 1; }); }
  report.nativeExit = await native.close();
  console.log(JSON.stringify(report, null, 2));
}
