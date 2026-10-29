/**
 * Read the native catalog, then compare each enabled selector, efficient and
 * omission with init.model and applied settings. Uses the existing login and
 * may contact account/catalog services, but sends no model prompt or login.
 * OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-native/model-selection.ts
 * Add --verify-open to also pass each enabled public listModels id to session().
 * Only model fields and an allowlist of applied settings are retained.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { qoderRuntime } from "../../packages/oar/src/index.js";
import { qoderControl, qoderInitializeTimeoutMs } from "../../packages/oar/src/runtimes/qoder/control.js";
import { closeQoder, launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const installation = await qoderRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable", "Qoder executable unavailable");
const { command } = installation;
const cwd = await mkdtemp(path.join(tmpdir(), "oar-qoder-models-"));
const output = path.resolve("oar-trial-run/qoder-model-selection/report.json");
const observations: unknown[] = [];
const opened: unknown[] = [];

interface ModelObservation {
  readonly requestedModel: string | null;
  readonly initModel: string | null;
  readonly appliedKeys: readonly string[];
  readonly applied: { readonly effort?: unknown; readonly ultracode?: unknown; readonly model?: unknown };
  readonly catalogs: Readonly<Record<string, readonly JsonRecord[]>>;
  readonly catalogMs: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
}

async function observe(model?: string, live = false): Promise<ModelObservation> {
  const started = performance.now();
  const child = await launchQoder(command, randomUUID(), { cwd, ...(model === undefined ? {} : { model }) });
  const control = qoderControl(child, () => {});
  let initModel: string | null = null;
  child.onLine((line) => {
    const frame = asRecord(parseJson(line));
    if (frame === null) { return; }
    if (frame.type === "system" && frame.subtype === "init" && typeof frame.model === "string") { initModel = frame.model; }
    control.consume(frame);
  });
  child.onExit(control.end);
  try {
    await control.request({ subtype: "initialize" }, qoderInitializeTimeoutMs);
    const settings = await control.request({ subtype: "get_settings" });
    const applied = asRecord(asRecord(asRecord(settings.response)?.response)?.applied);
    const catalogs: Record<string, readonly JsonRecord[]> = {};
    const catalogMs: Record<string, number> = {};
    for (const fetchStrategy of live ? ["cache", "live"] : ["cache"]) {
      const queryStarted = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const answer = await control.request({ subtype: "get_models", fetchStrategy });
      catalogs[fetchStrategy] = asRecordList(asRecord(asRecord(answer.response)?.response)?.models);
      catalogMs[fetchStrategy] = Math.round((performance.now() - queryStarted) * 1000) / 1000;
    }
    const observation = { requestedModel: model ?? null, initModel, appliedKeys: Object.keys(applied ?? {}),
      applied: { effort: applied?.effort, ultracode: applied?.ultracode, model: applied?.model },
      catalogs, catalogMs, elapsedMs: Math.round(performance.now() - started) };
    observations.push(observation);
    return observation;
  } finally { control.end(); await closeQoder(child); }
}

try {
  const first = await observe(undefined, true);
  const selectors = first.catalogs.live?.filter((entry) => entry.isEnabled !== false && typeof entry.value === "string").map((entry) => String(entry.value)) ?? [];
  for (const selector of new Set([...selectors, "efficient"])) {
    // eslint-disable-next-line no-await-in-loop
    await observe(selector);
  }
  if (process.argv.includes("--verify-open")) {
    const listed = await qoderRuntime.listModels(installation, { cwd });
    assert.equal(listed.kind, "ok");
    const enabled = listed.models.filter((model) => model.disabled === undefined);
    assert.ok(enabled.length > 0, "No enabled catalog models to verify");
    for (const entry of enabled) {
      // eslint-disable-next-line no-await-in-loop
      const session = await qoderRuntime.session(installation, { cwd, model: entry.id });
      try {
        const reported = session.model().value;
        assert.ok(reported === entry.id || reported === entry.resolvedId, "Native model did not match the listed id or resolved name");
        opened.push({ id: entry.id, resolvedId: entry.resolvedId, model: reported });
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await session.dispose();
      }
    }
  }
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ version: installation.version, platform: process.platform, observedAt: new Date().toISOString(), observations, opened }, null, 2)}\n`, { mode: 0o600 });
  await rm(cwd, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ output, observations: observations.length, opened })}\n`);
