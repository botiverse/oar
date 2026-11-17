/** One no-prompt session, either the creation baseline or the model-switch measurement. */
/* oxlint-disable no-await-in-loop, typescript/promise-function-async -- Native configuration and restoration are sequential. */
import assert from "node:assert/strict";
import { createAcpClient, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { hasAcpCapability } from "../../packages/oar/src/shared/acp/profile.js";
import { acpReportedModel, acpThoughtLevelOption } from "../../packages/oar/src/shared/acp/model.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";
import { antigravityAcpArgs } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { privateResponses } from "./wire-filter.js";
import { compareInventory, inventory } from "./file-inventory.js";
import { compareSnapshots, configFiles, configRoots, snapshot } from "./config-diff.js";

function strings(value: unknown, key: string): string[] {
  return asRecordList(value).flatMap(item => typeof item[key] === "string" ? [item[key]] : []);
}

function menu(response: JsonRecord): { id: string | null; currentValue: string | null; options: string[] } | null {
  const option = acpThoughtLevelOption(response);
  return option === null ? null : { id: typeof option.id === "string" ? option.id : null,
    currentValue: typeof option.currentValue === "string" ? option.currentValue : null, options: strings(option.options, "value") };
}

export interface Selection { readonly model: string; readonly effort: string | null }

export interface ProbeOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly mode: "baseline" | "switches" | "leave_selected" | "restore";
  readonly targetModel?: string;
  readonly expectedInitial?: Selection;
  readonly restoreSelection?: Selection;
}

export async function probeRealMenus({ command, cwd, env, mode, targetModel, expectedInitial, restoreSelection }: ProbeOptions): Promise<JsonRecord> {
  const roots = configRoots(cwd, env);
  const files = configFiles(roots);
  const beforeInventory = await inventory(roots);
  const before = await snapshot(files);
  const publicValues = new Set<string>();
  const timings: JsonRecord[] = [];
  const phases: JsonRecord[] = [];
  const switches: JsonRecord[] = [];
  const report: JsonRecord = { schema: 1, mode, provider: "operator-selected profile", platform: process.platform,
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
  const allowed = new Set(["initialize", "session/new", "session/close", ...(mode === "baseline" ? [] : ["session/set_config_option"])]);
  const outgoing: string[] = [];
  const responses = privateResponses();
  const runtime = startAcpProcess(command, antigravityAcpArgs(env), createAcpClient({ name: "oar-model-menu-probe" }), {
    cwd, env, inheritStderr: false, redact: () => "[native diagnostic redacted]",
    outgoing: message => {
      const record = asRecord(message);
      if (typeof record?.method === "string") {
        assert.ok(allowed.has(record.method), "The probe must not send prompts or other methods");
        outgoing.push(record.method);
        responses.outgoing(message);
      }
    },
    // No native notification, reverse request or diagnostic is printed or saved.
    incoming: message => responses.incoming(message),
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
  let originalEffort: string | null = null;
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
    originalEffort = originalMenu?.currentValue ?? null;
    const models = strings(asRecordList(opened.configOptions).find(option => option.id === "model")?.options, "value");
    const availableModelIds = strings(asRecord(opened.models)?.availableModels, "modelId");
    for (const value of [...models, ...availableModelIds, ...(originalMenu?.options ?? [])]) { publicValues.add(value); }
    report.availableModelIds = availableModelIds;
    report.initial = { model: originalModel, thoughtLevel: originalMenu };
    report.modelIds = models;
    await capture(phase);
    if (mode === "restore") {
      assert.ok(restoreSelection !== undefined, "Restoration requires the previously observed selection");
      originalModel = restoreSelection.model; originalEffort = restoreSelection.effort;
      selectionAttempted = true;
    } else if (mode !== "baseline") {
      if (expectedInitial !== undefined) {
        assert.deepEqual({ model: originalModel, effort: originalEffort }, expectedInitial, "Defaults changed before the persistence control");
      }
      assert.ok(originalModel !== null && models.includes(originalModel), "Initial model must be restorable through the native selector");
      assert.ok(originalMenu === null || (originalMenu.id !== null && originalMenu.currentValue !== null &&
        originalMenu.options.includes(originalMenu.currentValue)), "Initial effort must be known before changing the model");
      const selectedModels = mode === "leave_selected" ? [targetModel] : models;
      for (const model of selectedModels) {
        assert.ok(typeof model === "string" && models.includes(model), "Target must be in the native model selector");
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
    }
  } catch (error) {
    // Error messages/data can contain credentials, local paths and account identities.
    report.failure = { phase, code: typeof asRecord(error)?.code === "number" ? asRecord(error)?.code : null };
  } finally {
    if (selectionAttempted && sessionId !== undefined && originalModel !== null && (mode !== "leave_selected" || report.failure !== null)) {
      try {
        const restored = await request("session/set_config_option", { sessionId, configId: "model", value: originalModel }, "restore/model");
        assert.equal(acpReportedModel(restored), originalModel);
        const restoredMenu = menu(restored);
        let effortRestored = originalEffort === null;
        if (!effortRestored) {
          assert.ok(restoredMenu?.id !== null && restoredMenu?.id !== undefined && originalEffort !== null);
          assert.ok(restoredMenu.options.includes(originalEffort));
          const answer = await request("session/set_config_option", { sessionId, configId: restoredMenu.id, value: originalEffort }, "restore/effort");
          assert.equal(menu(answer)?.currentValue, originalEffort, "Native effort restoration was not confirmed");
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
    report.fileInventory = compareInventory(beforeInventory, await inventory(roots));
    report.elapsedMs = performance.now() - started;
    report.requestCount = outgoing.length;
    report.methods = outgoing;
  }
  return report;
}

