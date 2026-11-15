import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { effortLevelOf, effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { startDroidClient } from "./client.js";

const LIST_TIMEOUT_MS = 30_000;

/**
 * `droid.list_models` (stream-jsonrpc, answered before any session and
 * without a login): Factory's catalog for this account plus the custom
 * (BYOK) models in droid's settings, ids as `initialize_session` takes them.
 */
export function projectFactoryModels(result: unknown): ModelEntry[] {
  return asRecordList(asRecord(result)?.models).flatMap((model): ModelEntry[] => {
    if (typeof model.id !== "string" || model.id.length === 0) { return []; }
    const efforts = effortLevelsOf(model.supportedReasoningEfforts);
    const defaultEffort = effortLevelOf(model.defaultReasoningEffort);
    return [{
      id: model.id,
      ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
      ...(efforts === undefined ? {} : { effortLevels: efforts }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(model.disabled === true ? { disabled: { reason: typeof model.disabledReason === "string" ? model.disabledReason : "droid reports this model disabled" } } : {}),
    }];
  });
}

export const factoryListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "Factory droid lists models through its executable" }; }
  const client = startDroidClient(installation.command, { cwd: listingCwd(options), env: sessionEnvironment(options.env) });
  client.handle({ onNotification: () => {}, onUnmatched: () => {}, onServerRequest: (message) => { client.respond(message.id, { error: { code: -32_601, message: "not handled" } }); } });
  try {
    const result = await Promise.race([
      client.request("droid.list_models", {}),
      new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error("droid did not list its models in time")); }, LIST_TIMEOUT_MS).unref(); }),
    ]);
    return { kind: "ok", models: projectFactoryModels(result) };
  } finally { client.kill(); await client.exited; }
};
