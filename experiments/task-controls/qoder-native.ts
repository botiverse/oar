/* oxlint-disable import/max-dependencies -- Manual native control probe with private credential setup and bounded cleanup. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { launchQoder, closeQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { qoderControl } from "../../packages/oar/src/runtimes/qoder/control.js";
import { nativeControl, NativeFailureError } from "../qoder-deepseek/native-control.js";

const command = process.env.QODER_PROBE_COMMAND;
assert.ok(command !== undefined && command.length > 0, "Set QODER_PROBE_COMMAND privately.");
const secret = process.env.DEEPSEEK_API_KEY;
const run = process.argv.includes("--run");
if (run) { assert.ok(secret !== undefined && secret.length > 0, "Inject DEEPSEEK_API_KEY privately before --run."); }
const daemon = nativeControl(command);
const key = `oar-task-probe/${randomUUID()}`;
let created = false;
let directory: string | null = null;
let child: Awaited<ReturnType<typeof launchQoder>> | null = null;
let stage = "initialize";
const evidence: JsonRecord[] = [];
const checks: JsonRecord[] = [];
const report: JsonRecord = { platform: `${process.platform}-${process.arch}`, mode: run ? "real-inference" : "read-only", submittedPrompts: 0, checks, evidence };
const deadline = setTimeout(() => { child?.kill(); }, 270_000);
const selected = new Set(["task_started", "task_updated", "task_progress", "task_notification"]);
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const term of [secret, directory, process.env.HOME, key]) {
      if (term !== undefined && term !== null && term.length > 0) { text = text.replaceAll(term, "[redacted]"); }
    }
    return text;
  }
  if (Array.isArray(value)) { return value.map(entry => redact(entry)); }
  const object = asRecord(value);
  return object === null ? value : Object.fromEntries(Object.entries(object).map(([name, entry]) => [name, name === "output_file" && typeof entry === "string" && entry !== "" ? "[task-output]" : redact(entry)]));
}
async function wait(predicate: () => boolean, timeoutMs = 100_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) { throw new NativeFailureError("EVIDENCE_TIMEOUT"); }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded native observation, not independent work.
    await delay(20);
  }
}

function redactedFrame(frame: JsonRecord): JsonRecord {
  const result = asRecord(redact(frame)); assert.ok(result !== null); return result;
}
const rootEnd = (frame: JsonRecord): boolean => frame.type === "result" && typeof frame.parent_tool_use_id !== "string";
try {
  const init = await daemon.initialize();
  assert.equal(init.daemon_version, "1.1.83", "Recheck native account/config semantics for another version.");
  report.version = init.daemon_version;
  stage = "access";
  const access = await daemon.request("daemon.check_byok_config", { config: { provider: "deepseek", model: "deepseek-flash-pg", type: "pg", parameters: {} } });
  report.access = { success: access.success, code: access.code, emptyParameters: access.error === "parameters must not be empty" };
  assert.equal(access.code, "BYOK_CONFIG_INVALID"); assert.equal(access.error, "parameters must not be empty");
  if (run) {
    stage = "create-config";
    const config = { key, provider: "deepseek", model: "deepseek-flash-pg", type: "pg", parameters: { api_key: secret } };
    const validated = await daemon.request("daemon.check_byok_config", { config });
    assert.equal(validated.success, true);
    const before = await daemon.request("daemon.list_byok_configs");
    assert.ok(!asRecordList(before.configs).some(row => row.key === key));
    created = true;
    const configured = await daemon.request("daemon.create_byok_config", { config });
    assert.equal(asRecord(configured.config)?.key, key);
    directory = await mkdtemp(path.join(tmpdir(), "oar-qoder-tasks-"));
    stage = "open";
    child = await launchQoder(command, randomUUID(), { cwd: directory, model: key, env: { DEEPSEEK_API_KEY: null }, disallowedTools: ["WebFetch", "WebSearch"] }, "1.1.83");
    const transport = child;
    const privateControl = qoderControl(transport, () => {});
    const pending = new Map<string, PromiseWithResolvers<JsonRecord>>();
    const frames: JsonRecord[] = [];
    transport.onExit(() => { privateControl.end(); });
    transport.onLine(line => {
      const frame = asRecord(parseJson(line));
      if (frame === null || privateControl.consume(frame)) { return; }
      // Never retain initialize or account/configuration responses. Task frames
      // are the native object, with only explicit local/private values redacted.
      if (frame.type === "system" && selected.has(String(frame.subtype))) { evidence.push(redactedFrame(frame)); }
      const response = asRecord(frame.response);
      if (frame.type === "control_response" && typeof response?.request_id === "string" && pending.has(response.request_id)) {
        evidence.push(redactedFrame(frame)); pending.get(response.request_id)?.resolve(frame);
      }
      if (frame.type === "result") {
        const fields = ["type", "subtype", "is_error", "session_id", "parent_tool_use_id", "usage", "modelUsage", "duration_ms", "num_turns"];
        const selectedFields: [string, unknown][] = fields.filter(name => Object.hasOwn(frame, name)).map(name => [name, frame[name]]);
        evidence.push(redactedFrame(Object.fromEntries(selectedFields)));
      }
      frames.push(frame);
    });
    await privateControl.request({ subtype: "initialize" }, 60_000);
    const stop = async (taskId: string): Promise<JsonRecord> => {
      const id = `task-stop-${pending.size}`;
      const reply = Promise.withResolvers<JsonRecord>(); pending.set(id, reply);
      const timer = setTimeout(() => { reply.reject(new NativeFailureError("STOP_TIMEOUT")); }, 30_000);
      const request = { type: "control_request", request_id: id, request: { subtype: "stop_task", task_id: taskId } };
      evidence.push(request); transport.write(`${JSON.stringify(request)}\n`);
      try { return await reply.promise; } finally { clearTimeout(timer); }
    };
    const prompt = (text: string): void => {
      report.submittedPrompts = Number(report.submittedPrompts) + 1;
      transport.write(`${JSON.stringify({ type: "user", priority: "next", uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text }] } })}\n`);
    };
    stage = "foreground";
    let after = frames.length;
    prompt('This is a native task-control integration probe. Use the Task tool exactly once, subagent_type general-purpose, description OAR_TASK_FOREGROUND, run_in_background false. Tell that child: use Bash once to run `sleep 45; echo OAR_FOREGROUND_DONE`, then return OAR_FOREGROUND_DONE. Do not run shell in the parent. Wait for the child; if interrupted do not retry. Reply PARENT_FOREGROUND_DONE after it settles. Do not use any other tools or tasks.');
    await wait(() => frames.slice(after).some(frame => frame.subtype === "task_started" && frame.task_type === "local_agent"));
    const foreground = frames.slice(after).find(frame => frame.subtype === "task_started" && frame.task_type === "local_agent");
    assert.equal(typeof foreground?.task_id, "string");
    await delay(750);
    const stopped = await stop(String(foreground?.task_id));
    await wait(() => frames.slice(after).some(frame => frame.subtype === "task_notification" && frame.task_id === foreground?.task_id));
    await wait(() => frames.slice(after).some(frame => rootEnd(frame)));
    checks.push({ name: "foreground", taskId: foreground?.task_id, reply: asRecord(stopped.response)?.subtype, ended: frames.slice(after).find(frame => frame.subtype === "task_notification" && frame.task_id === foreground?.task_id)?.status });
    stage = "background-sibling";
    after = frames.length;
    prompt('Native task-control probe. Use Task exactly twice, both subagent_type general-purpose and run_in_background true. First description OAR_TASK_TARGET: tell the child to use Bash once for `sleep 60; echo OAR_TARGET_DONE`. Second description OAR_TASK_PEER: tell the child to use Bash once for `sleep 8; echo OAR_PEER_DONE`. Launch both. Do not run shell in the parent, stop tasks, retry tasks, or spawn more tasks. Reply PARENT_BACKGROUND_DONE after launching them.');
    const starts = (): JsonRecord[] => frames.slice(after).filter(frame => frame.subtype === "task_started" && frame.task_type === "local_agent");
    await wait(() => starts().length === 2);
    const target = starts().find(frame => String(frame.description).includes("TARGET"));
    const peer = starts().find(frame => String(frame.description).includes("PEER"));
    assert.ok(target !== undefined && peer !== undefined);
    const reply = await stop(String(target.task_id));
    await wait(() => frames.slice(after).some(frame => frame.subtype === "task_notification" && frame.task_id === target.task_id));
    await wait(() => frames.slice(after).some(frame => frame.subtype === "task_notification" && frame.task_id === peer.task_id));
    await wait(() => frames.slice(after).some(frame => rootEnd(frame)));
    checks.push({ name: "background-sibling", reply: asRecord(reply.response)?.subtype,
      target: frames.slice(after).find(frame => frame.subtype === "task_notification" && frame.task_id === target.task_id)?.status,
      peer: frames.slice(after).find(frame => frame.subtype === "task_notification" && frame.task_id === peer.task_id)?.status });
    stage = "parent-followup";
    after = frames.length;
    prompt("Without using tools, reply exactly PARENT_STILL_USABLE.");
    await wait(() => frames.slice(after).some(frame => rootEnd(frame)));
    const end = frames.slice(after).find(frame => rootEnd(frame));
    checks.push({ name: "parent-followup", subtype: end?.subtype, isError: end?.is_error });
  }
} catch (error) {
  const code = error instanceof Error ? error.name : "ERROR";
  report.failure = { stage, code: error instanceof NativeFailureError ? error.code : code };
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (child !== null) { child.kill(); await closeQoder(child).catch(() => { report.cleanupFailed = true; }); }
  if (created) {
    try {
      const current = await daemon.request("daemon.list_byok_configs");
      if (asRecordList(current.configs).some(row => row.key === key)) { await daemon.request("daemon.delete_byok_config", { target: { key } }); }
      const remaining = await daemon.request("daemon.list_byok_configs");
      report.configRemoved = !asRecordList(remaining.configs).some(row => row.key === key);
    } catch { report.configRemoved = false; process.exitCode = 1; }
  }
  if (directory !== null) { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => { report.directoryCleanupFailed = true; }); }
  report.nativeExit = await daemon.close();
  console.log(JSON.stringify(report, null, 2));
}
