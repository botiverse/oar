import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { DshCommandError, dshControl } from "./control.js";
import { dshEnvironment, dshExecutableRefusal, launchDsh } from "./launch.js";

/** The native catalog as `Session.model` selectors. A provider that could not list is not a model; the caller decides what no model means. */
export function projectDshModels(catalog: JsonRecord): readonly ModelEntry[] {
  const selected = asRecord(catalog.default);
  return asRecordList(catalog.providers).flatMap((provider) => {
    if (typeof provider.id !== "string") { return []; }
    const providerId = provider.id;
    return asRecordList(provider.models).flatMap((model): ModelEntry[] => {
      if (typeof model.id !== "string") { return []; }
      const reasoning = asRecord(model.reasoning);
      const efforts = reasoning === null ? undefined : effortLevelsOf(asRecordList(reasoning.efforts).map((effort) => effort.id));
      return [{
        id: `${providerId}/${model.id}`,
        ...(typeof model.name === "string" ? { displayName: model.name } : {}),
        provider: { id: providerId, ...(typeof provider.name === "string" ? { displayName: provider.name } : {}) },
        ...(efforts === undefined ? {} : { effortLevels: efforts }),
        ...(typeof reasoning?.defaultEffort === "string" ? { defaultEffort: reasoning.defaultEffort } : {}),
        ...(selected?.provider === providerId && selected.model === model.id ? { default: true as const } : {}),
      }];
    });
  });
}

/** Native `llm.listProviders`, `listModels` and `resolveModelInfo`, in a short-lived process started the way a session is. */
export const dshListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "DSH model listing requires its executable" }; }
  const env = dshEnvironment(options.env);
  const refusal = await dshExecutableRefusal(installation.command, installation.version, env);
  if (refusal !== null) { return { kind: "unsupported", reason: refusal }; }
  const { child } = await launchDsh(installation.command, listingCwd(options), env);
  const control = dshControl(child, () => {});
  try {
    await control.ready;
    const catalog = await control.request("models", {}, options.timeoutMs);
    const models = projectDshModels(catalog);
    if (models.length === 0) {
      const failures = asRecordList(catalog.providers).flatMap((provider) => typeof provider.failure === "string" ? [`${String(provider.id)}: ${provider.failure}`] : []);
      if (failures.length > 0) { return { kind: "unsupported", reason: `DSH could not list any provider's models: ${failures.join("; ")}` }; }
    }
    return { kind: "ok", models };
  } catch (error) {
    if (error instanceof DshCommandError && error.code === "native_method_unavailable") { return { kind: "unsupported", reason: error.message }; }
    throw error;
  } finally {
    child.kill();
    await child.exited;
  }
};
