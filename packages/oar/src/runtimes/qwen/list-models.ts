import { randomUUID } from "node:crypto";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, parseJson } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { closeQwen } from "./close.js";
import { launchQwen } from "./launch.js";
import { qwenControl, QWEN_CONTROL_TIMEOUT_MS } from "./control.js";

export function projectQwenModels(payload: unknown): ModelEntry[] {
  return asRecordList(asRecord(payload)?.models).flatMap((model) => {
    if (typeof model.id !== "string" || model.id.length === 0) { return []; }
    const reasoning = asRecord(asRecord(model.capabilities)?.reasoning);
    const effortLevels = effortLevelsOf(reasoning?.efforts);
    return [{ id: model.id,
      ...(typeof model.label === "string" ? { displayName: model.label } : {}),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(typeof reasoning?.defaultEffort === "string" ? { defaultEffort: reasoning.defaultEffort } : {}),
    }];
  });
}

/** Native catalog query; the environment parameter also lets the native harness isolate HOME. */
export async function readQwenModels(command: string, cwd: string, timeoutMs = QWEN_CONTROL_TIMEOUT_MS, env?: Readonly<Record<string, string>>): Promise<ModelEntry[]> {
  const child = await launchQwen(command, randomUUID(), { cwd, ...(env === undefined ? {} : { env }) });
  const control = qwenControl(child, timeoutMs);
  child.onLine((line) => { const value = asRecord(parseJson(line)); if (value !== null) { control.consume(value); } });
  child.onExit(() => { control.end(); });
  try {
    await control.request({ subtype: "initialize" });
    const answer = await control.request({ subtype: "get_available_models" });
    return projectQwenModels(asRecord(answer.response)?.response);
  } finally { control.end(); await closeQwen(child); }
}

export const qwenListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "Qwen model listing requires its executable" }; }
  return { kind: "ok", models: await readQwenModels(installation.command, listingCwd(options), options.timeoutMs) };
};
