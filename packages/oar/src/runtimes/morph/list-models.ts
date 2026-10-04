import type { ListModelsResult, ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { acquireConsole, morphStateDir } from "./console.js";

/**
 * Console's LLM profiles (`GET /llm/profiles`) as models: the profile name is
 * the selector a session's `model` takes (sent as `llm_profile`), the model it
 * names today is `resolvedId`. The default profile comes first.
 */
export function projectMorphModels(catalog: unknown): ModelEntry[] {
  const record = asRecord(catalog);
  const models: ModelEntry[] = [];
  for (const profile of [asRecord(record?.default), ...asRecordList(record?.items)]) {
    if (typeof profile?.name !== "string" || profile.name === "" || models.some((model) => model.id === profile.name)) {
      continue;
    }
    models.push({
      id: profile.name,
      ...(typeof profile.model === "string" && profile.model !== "" ? { resolvedId: profile.model } : {}),
    });
  }
  return models;
}

export const morphListModels: ModelLister = async (installation): Promise<ListModelsResult> => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "morph models are listed by its Console, which needs the morph executable" };
  }
  const lease = await acquireConsole(installation.command, morphStateDir());
  try {
    return { kind: "ok", models: projectMorphModels(await lease.client.expect("GET", "/llm/profiles")) };
  } finally {
    await lease.release();
  }
};
