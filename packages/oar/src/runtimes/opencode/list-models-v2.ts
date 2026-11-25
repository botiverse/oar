import { setTimeout as delay } from "node:timers/promises";
import type { ListModelsResult, ModelEntry } from "../../contracts/list-models.js";
import type { OwnQueryProcess } from "../../shared/executable/query.js";
import { nativeRows } from "../../shared/inventory.js";
import type { JsonRecord } from "../../shared/json.js";
import { openDiscoveryServer } from "./discovery-server.js";

function modelId(value: unknown): string {
  if (typeof value !== "string" || !/^\S+$/u.test(value)) { throw new TypeError("OpenCode model catalog contains an invalid identifier"); }
  return value;
}

function projectV2Model(row: JsonRecord): ModelEntry {
  const provider = modelId(row.providerID);
  const id = `${provider}/${modelId(row.id)}`;
  const displayName = typeof row.name === "string" ? row.name.trim() : "";
  const variants = nativeRows(row.variants ?? []);
  const levels = variants.map(variant => {
    if (typeof variant.id !== "string" || variant.id.length === 0) { throw new TypeError("OpenCode model variant has no id"); }
    return variant.id;
  });
  const effortLevels = [...new Set(levels.filter(level => level !== "default"))];
  return {
    id, provider: { id: provider },
    ...(displayName === "" ? {} : { displayName }),
    ...(effortLevels.length === 0 ? {} : { effortLevels }),
  };
}

export async function listV2Models(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, own: OwnQueryProcess): Promise<ListModelsResult> {
  const read = await openDiscoveryServer(command, cwd, env, "models", signal, own);
  // The native one-shot CLI polls for its first plugins for up to five seconds.
  // On 2.4.0+, package plugins can still add models after this snapshot.
  const until = performance.now() + 5000;
  let plugins = await read("/api/plugin");
  while (plugins.length === 0 && performance.now() < until) {
    await delay(25, undefined, { signal });
    plugins = await read("/api/plugin");
  }
  const rows = await read("/api/model");
  if (rows.length === 0) { return { kind: "unsupported", reason: "OpenCode returned an empty model snapshot before catalog readiness could be established" }; }
  const models = rows.map(row => projectV2Model(row)).toSorted((a, b) => a.id.localeCompare(b.id));
  return { kind: "ok", models };
}
