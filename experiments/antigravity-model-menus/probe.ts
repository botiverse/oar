/** One session, no prompt: measure menus and file changes on a deliberately selected profile. */
/* oxlint-disable no-await-in-loop, typescript/promise-function-async -- Native configuration and restoration are sequential. */
import assert from "node:assert/strict";
import { createAcpClient, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { hasAcpCapability } from "../../packages/oar/src/shared/acp/profile.js";
import { acpReportedModel, acpThoughtLevelOption } from "../../packages/oar/src/shared/acp/model.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";
import { antigravityAcpArgs } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { compareSnapshots, configFiles, snapshot } from "./config-diff.js";

function strings(value: unknown, key: string): string[] {
  return asRecordList(value).flatMap(item => typeof item[key] === "string" ? [item[key]] : []);
}

function menu(response: JsonRecord): { id: string | null; currentValue: string | null; options: string[] } | null {
  const option = acpThoughtLevelOption(response);
  return option === null ? null : { id: typeof option.id === "string" ? option.id : null,
    currentValue: typeof option.currentValue === "string" ? option.currentValue : null, options: strings(option.options, "value") };
}

export async function probeRealMenus(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<JsonRecord> {
  const files = configFiles(cwd, env);
  const before = await snapshot(files);
  const publicValues = new Set<string>();
  const timings: JsonRecord[] = [];
  const phases: JsonRecord[] = [];
  const switches: JsonRecord[] = [];
  const report: JsonRecord = { schema: 1, provider: "operator-selected profile", platform: process.platform,
    promptRequests: 0, timings, phases, switches, failure: null, restoration: null };
  let previous = before;
  const capture = async (phase: string): Promise<void> => {
    const current = await snapshot(files);
    phases.push({ phase, files: compareSnapshots(before, current, publicValues),
      changesSincePrevious: compareSnapshots(previous, current, publicValues).filter(file => asRecord(file)?.equal !== true) });
    previous = current;
  };
  await capture("before");
  const version = await runExecutable(command, ["--version"], { cwd, env, timeoutMs: 30_000 });
  report.version = version.ok ? /\b\d+\.\d+\.\d+\b/u.exec(version.stdout)?.[0] ?? null : null;
  assert.ok(report.version !== null, "The selected executable must report its version");
  const allowed = new Set(["initialize", "session/new", "session/set_config_option", "session/close"]);
  const outgoing: string[] = [];
  const runtime = startAcpProcess(command, antigravityAcpArgs(env), createAcpClient({ name: "oar-model-menu-probe" }), {
    cwd, env, inheritStderr: false, redact: () => "[native diagnostic redacted]",
    outgoing: message => {
      const record = asRecord(message);
      if (typeof record?.method === "string") {
        assert.ok(allowed.has(record.method), "The probe must not send prompts or other methods");
        outgoing.push(record.method);
      }
    },
    // No native notification, reverse request or diagnostic is printed or saved.
    incoming: message => typeof asRecord(message)?.method === "string" ? undefined : message,
  });
  const request = async (method: string, params: JsonRecord, phase: string): Promise<JsonRecord> => {
    assert.ok(allowed.has(method));
    const started = performance.now();
    let ok = false;
    try {
      const answer = asRecord(await withAcpDeadline(runtime, method, 30_000,
        options => runtime.connection.agent.request(method, params, options))) ?? {};
      ok = true; return answer;
    } finally { timings.push({ method, phase, ok, elapsedMs: performance.now() - started }); }
  };
  let sessionId: string | undefined = undefined;
  let originalModel: string | null = null;
  let originalMenu: ReturnType<typeof menu> = null;
  let canClose = false;
  let selectionAttempted = false;
  let phase = "initialize";
  const started = performance.now();
  try {
    const initialized = await request("initialize", { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "oar", version: "0.0.0" } }, phase);
    canClose = hasAcpCapability(asRecord(asRecord(initialized.agentCapabilities)?.sessionCapabilities)?.close);
    await capture(phase);
    phase = "session/new";
    const opened = await request(phase, { cwd, mcpServers: [] }, phase);
    assert.ok(typeof opened.sessionId === "string", "Native session ID missing");
    ({ sessionId } = opened);
    originalModel = acpReportedModel(opened); originalMenu = menu(opened);
    const models = strings(asRecordList(opened.configOptions).find(option => option.id === "model")?.options, "value");
    const availableModelIds = strings(asRecord(opened.models)?.availableModels, "modelId");
    for (const value of [...models, ...availableModelIds, ...(originalMenu?.options ?? [])]) { publicValues.add(value); }
    report.availableModelIds = availableModelIds;
    report.initial = { model: originalModel, thoughtLevel: originalMenu };
    report.modelIds = models;
    await capture(phase);
    assert.ok(originalModel !== null && models.includes(originalModel), "Initial model must be restorable through the native selector");
    assert.ok(originalMenu === null || (originalMenu.id !== null && originalMenu.currentValue !== null &&
      originalMenu.options.includes(originalMenu.currentValue)), "Initial effort must be known before changing the model");
    for (const model of models) {
      phase = `switch/${switches.length}`;
      selectionAttempted = true;
      const response = await request("session/set_config_option", { sessionId, configId: "model", value: model }, phase);
      const thoughtLevel = menu(response);
      const reportedModel = acpReportedModel(response);
      for (const value of thoughtLevel?.options ?? []) { publicValues.add(value); }
      switches.push({ modelId: model, reportedModel, thoughtLevel, elapsedMs: timings.at(-1)?.elapsedMs });
      await capture(phase);
      assert.equal(reportedModel, model, "Native switch did not confirm the selected model");
    }
  } catch (error) {
    // Error messages/data can contain credentials, local paths and account identities.
    report.failure = { phase, code: typeof asRecord(error)?.code === "number" ? asRecord(error)?.code : null };
  } finally {
    if (selectionAttempted && sessionId !== undefined && originalModel !== null) {
      try {
        const restored = await request("session/set_config_option", { sessionId, configId: "model", value: originalModel }, "restore/model");
        assert.equal(acpReportedModel(restored), originalModel);
        const restoredMenu = menu(restored);
        let effortRestored = originalMenu?.currentValue === undefined || originalMenu.currentValue === null;
        if (!effortRestored) {
          assert.ok(restoredMenu?.id !== null && restoredMenu?.id !== undefined && originalMenu?.currentValue !== null && originalMenu?.currentValue !== undefined);
          assert.ok(restoredMenu.options.includes(originalMenu.currentValue));
          const answer = await request("session/set_config_option", { sessionId, configId: restoredMenu.id, value: originalMenu.currentValue }, "restore/effort");
          assert.equal(menu(answer)?.currentValue, originalMenu.currentValue, "Native effort restoration was not confirmed");
          effortRestored = true;
        }
        report.restoration = { model: true, effort: effortRestored };
      } catch { report.restoration = { confirmed: false }; }
      await capture("after_restore");
    }
    if (sessionId !== undefined && canClose) {
      try { await request("session/close", { sessionId }, "close"); }
      catch { report.closeFailed = true; }
    }
    runtime.kill(); await runtime.exited;
    await capture("after_exit");
    report.elapsedMs = performance.now() - started;
    report.requestCount = outgoing.length;
    report.methods = outgoing;
  }
  return report;
}

