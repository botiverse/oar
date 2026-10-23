import { randomUUID } from "node:crypto";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import type { SessionOptions } from "../../contracts/session.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, parseJson } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { launchQoder, closeQoder } from "./launch.js";
import { qoderControl } from "./control.js";
import { qoderAuthStatus } from "./auth-status.js";

export function projectQoderModels(payload: unknown): ModelEntry[] {
  return asRecordList(asRecord(payload)?.models).flatMap((model) => {
    if (typeof model.value !== "string" || model.value.length === 0) { return []; }
    const efforts = effortLevelsOf(model.efforts);
    return [{ id: model.value,
      ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
      ...(efforts === undefined ? {} : { effortLevels: efforts }),
      ...(typeof model.defaultEffort === "string" ? { defaultEffort: model.defaultEffort } : {}),
      ...(model.isDefault === true ? { default: true as const } : {}),
      ...(model.isEnabled === false ? { disabled: { reason: "Qoder reports this model disabled" } } : {}),
    }];
  });
}

export async function readQoderModels(command: string, options: SessionOptions, timeoutMs = 30_000): Promise<ModelEntry[]> {
  const child = await launchQoder(command, randomUUID(), options);
  const control = qoderControl(child, () => {}, timeoutMs);
  child.onLine((line) => { const message = asRecord(parseJson(line)); if (message !== null) { control.consume(message); } });
  child.onExit(control.end);
  try {
    await control.request({ subtype: "initialize" });
    const answer = await control.request({ subtype: "get_models", fetchStrategy: "live" });
    return projectQoderModels(asRecord(answer.response)?.response);
  } finally { control.end(); await closeQoder(child); }
}

export const qoderListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "Qoder model listing requires its executable" }; }
  const status = await qoderAuthStatus(installation, options);
  if (status.kind === "logged_out") { return { kind: "unauthenticated" }; }
  return { kind: "ok", models: await readQoderModels(installation.command, { cwd: listingCwd(options) }, options.timeoutMs) };
};
