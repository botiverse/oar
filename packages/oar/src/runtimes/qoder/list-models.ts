import { randomUUID } from "node:crypto";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import type { SessionOptions } from "../../contracts/session.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { launchQoder, closeQoder } from "./launch.js";
import { qoderControl } from "./control.js";
import { qoderAuthStatus } from "./auth-status.js";
import { qoderVersionInfo } from "./protocol.js";

/** New ModelProvider names identify a selector only when the complete catalog is unambiguous. */
export function qoderNativeModelName(model: unknown, models: readonly JsonRecord[], version?: string): string | undefined {
  const entry = asRecord(model);
  if (version !== undefined && qoderVersionInfo(version).modelFormat === "provider") {
    const name = entry?.displayName;
    if (typeof entry?.value !== "string" || entry.value.length === 0 || entry.modelId !== entry.value || typeof name !== "string" || name.length === 0) { return undefined; }
    if (models.filter(row => row.displayName === name).length !== 1 || models.filter(row => row.value === entry.value).length !== 1) { return undefined; }
    return name;
  }
  const name = asRecord(entry?.serverModel)?.display_name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Pass the native CLI version for ModelProvider catalogs; omission retains the legacy projection. */
export function projectQoderModels(payload: unknown, version?: string): ModelEntry[] {
  const models = asRecordList(asRecord(payload)?.models);
  return models.flatMap((model) => {
    if (typeof model.value !== "string" || model.value.length === 0) { return []; }
    const efforts = effortLevelsOf(model.efforts);
    const resolvedId = qoderNativeModelName(model, models, version);
    return [{ id: model.value,
      ...(resolvedId !== undefined && resolvedId !== model.value ? { resolvedId } : {}),
      ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
      ...(efforts === undefined ? {} : { effortLevels: efforts }),
      ...(typeof model.defaultEffort === "string" ? { defaultEffort: model.defaultEffort } : {}),
      ...(model.isDefault === true ? { default: true as const } : {}),
      ...(model.isEnabled === false ? { disabled: { reason: "Qoder reports this model disabled" } } : {}),
    }];
  });
}

export async function readQoderModels(command: string, options: SessionOptions, timeoutMs = 30_000, version?: string): Promise<ModelEntry[]> {
  const child = await launchQoder(command, randomUUID(), options, version);
  const control = qoderControl(child, () => {}, timeoutMs);
  child.onLine((line) => { const message = asRecord(parseJson(line)); if (message !== null) { control.consume(message); } });
  child.onExit(control.end);
  try {
    await control.request({ subtype: "initialize" });
    const answer = await control.request({ subtype: "get_models", fetchStrategy: "live" });
    return projectQoderModels(asRecord(answer.response)?.response, child.qoderVersion);
  } finally { control.end(); await closeQoder(child); }
}

export const qoderListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "Qoder model listing requires its executable" }; }
  const status = await qoderAuthStatus(installation, options);
  if (status.kind === "logged_out") { return { kind: "unauthenticated" }; }
  return { kind: "ok", models: await readQoderModels(installation.command, { cwd: listingCwd(options), ...(options.env === undefined ? {} : { env: options.env }) }, options.timeoutMs, installation.version) };
};
