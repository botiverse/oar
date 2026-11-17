import { RequestError } from "@agentclientprotocol/sdk";
import type { ModelEntry } from "../../contracts/list-models.js";
import { acpThoughtLevelOption } from "../../shared/acp/model.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";

type SetOption = (configId: string, value: string) => Promise<unknown>;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readModelOption(response: unknown): JsonRecord | undefined {
  return asRecordList(asRecord(response)?.configOptions).find(option => option.id === "model");
}

function selected(response: unknown, model: string): boolean {
  return Array.isArray(asRecord(response)?.configOptions) && readModelOption(response)?.currentValue === model;
}

function readLevels(response: unknown): string[] {
  return asRecordList(acpThoughtLevelOption(asRecord(response))?.options).map(option => option.value).filter(value => nonempty(value));
}

function withoutEffort(entry: ModelEntry): ModelEntry {
  const result = { ...entry };
  delete result.effortLevels;
  delete result.defaultEffort;
  delete result.effortUnavailableReason;
  return result;
}

/** Read each menu while selected, restoring the temporary session before closing it. */
export async function readAntigravityModelMenus(
  opened: unknown,
  fallback: ModelEntry[],
  setOption: SetOption,
): Promise<ModelEntry[]> {
  const selector = readModelOption(opened);
  const original = selector?.currentValue;
  const ids = new Set(asRecordList(selector?.options).map(option => option.value).filter(value => nonempty(value)));
  const thought = acpThoughtLevelOption(asRecord(opened));
  const effort = thought?.currentValue;
  // Do not mutate a selection we cannot restore from the initial native response.
  if (!nonempty(asRecord(opened)?.sessionId) || !nonempty(original) || !ids.has(original)
    || (thought !== null && (!nonempty(thought.id) || !nonempty(effort) || !readLevels(opened).includes(effort)))) {
    return fallback;
  }
  let attempted = false;
  let methodMissing = false;
  try {
    const result: ModelEntry[] = [];
    for (const entry of fallback) {
      if (!ids.has(entry.id)) { result.push(entry); continue; }
      const clean = withoutEffort(entry);
      const first = !attempted;
      attempted = true;
      try {
        const response = await setOption("model", entry.id);
        if (!selected(response, entry.id)) { throw new Error("Model selection was not confirmed"); }
        const menu = readLevels(response);
        if (acpThoughtLevelOption(asRecord(response)) !== null && menu.length === 0) {
          throw new Error("Native effort menu was empty");
        }
        result.push({ ...clean,
          ...(menu.length > 0 ? { effortLevels: menu } : {}),
          ...(entry.id === original && nonempty(effort) && menu.includes(effort) ? { defaultEffort: effort } : {}),
        });
      } catch (error) {
        // Method-not-found on the first call means no selection was changed.
        if (first && error instanceof RequestError && error.code === -32_601) {
          methodMissing = true;
          return fallback;
        }
        result.push({ ...clean, effortUnavailableReason: "Native model selection did not return a confirmed effort menu." });
      }
    }
    return result;
  } finally {
    if (attempted && !methodMissing) {
      await restoreSelection(setOption, original, nonempty(effort) ? effort : null);
    }
  }
}

async function restoreSelection(setOption: SetOption, original: string, effort: string | null): Promise<void> {
  try {
    const restored = await setOption("model", original);
    if (!selected(restored, original)) { throw new Error("Original model was not confirmed"); }
    const option = acpThoughtLevelOption(asRecord(restored));
    if (effort === null) {
      if (option !== null) { throw new Error("Original absent effort menu was not restored"); }
      return;
    }
    if (!nonempty(option?.id) || !readLevels(restored).includes(effort)) {
      throw new Error("Original effort was not available for restoration");
    }
    const confirmed = await setOption(option.id, effort);
    if (!selected(confirmed, original) || acpThoughtLevelOption(asRecord(confirmed))?.currentValue !== effort) {
      throw new Error("Original effort was not confirmed");
    }
  } catch (error) {
    throw new Error("Antigravity model listing could not confirm restoration of the original selection", { cause: error });
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project a `session/new` fallback. agy CLI 1.5.0 has no model-list
 * method; the account's models ride on every new session as the
 * `configOptions` entry with id `model`, the option the session switches
 * through `session/set_config_option`. Its `thought_level` menu belongs only
 * to the current model. The legacy availableModels catalog enumerates
 * model/effort combinations for the other families without switching sessions.
 */
export function projectAntigravityModels(response: unknown): ModelEntry[] | undefined {
  const root = asRecord(response);
  const modelOption = asRecordList(root?.configOptions).find((option) => option.id === "model");
  if (modelOption === undefined) {
    return undefined;
  }
  // A new session's current model: what a session uses with no `model` set.
  const current = text(modelOption.currentValue);
  const thinking = acpThoughtLevelOption(root);
  const effortLevels = asRecordList(thinking?.options)
    .map((option) => text(option.value))
    .filter((value): value is string => value !== undefined);
  const defaultEffort = text(thinking?.currentValue);
  const entries: ModelEntry[] = [];
  for (const model of asRecordList(modelOption.options)) {
    const id = text(model.value);
    if (id === undefined) {
      continue;
    }
    const displayName = text(model.name);
    entries.push({
      id,
      ...(displayName === undefined || displayName === id ? {} : { displayName }),
      ...(id === current ? { default: true as const } : {}),
      ...(id === current && effortLevels.length > 0 ? { effortLevels } : {}),
      ...(id === current && defaultEffort !== undefined && effortLevels.includes(defaultEffort) ? { defaultEffort } : {}),
    });
  }
  return withCatalogEfforts(root, entries);
}

/** Never infer another model's menu from the current model's thought_level. */
function withCatalogEfforts(root: JsonRecord | null, entries: ModelEntry[]): ModelEntry[] {
  const available = asRecordList(asRecord(root?.models)?.availableModels);
  const levels = new Map<string, string[]>();
  const bareModels = new Set<string>();
  const unparsed: ModelEntry[] = [];
  for (const item of available) {
    const id = text(item.modelId);
    if (id === undefined) { continue; }
    if (entries.some(entry => entry.id === id)) { bareModels.add(id); continue; }
    const candidates = entries.filter(entry => id.startsWith(`${entry.id}-`) && id.length > entry.id.length + 1);
    const [family] = candidates;
    if (candidates.length === 1 && family !== undefined) {
      const value = id.slice(family.id.length + 1);
      const menu = levels.get(family.id) ?? [];
      if (!menu.includes(value)) { menu.push(value); }
      levels.set(family.id, menu);
    } else if (!unparsed.some(entry => entry.id === id)) {
      const displayName = text(item.name);
      unparsed.push({ id, ...(displayName === undefined || displayName === id ? {} : { displayName }),
        effortUnavailableReason: "Native model entry could not be associated with a unique model and effort." });
    }
  }
  const hasEfforts = levels.size > 0 || acpThoughtLevelOption(root) !== null;
  return [...entries.map(entry => {
    if (entry.effortLevels !== undefined) { return entry; }
    const menu = levels.get(entry.id);
    if (menu !== undefined) { return { ...entry, effortLevels: menu }; }
    return hasEfforts && !bareModels.has(entry.id) ? { ...entry, effortUnavailableReason: "Native catalog did not expose this model's effort menu." } : entry;
  }), ...unparsed];
}

