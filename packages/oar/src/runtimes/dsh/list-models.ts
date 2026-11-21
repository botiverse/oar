import { withQueryDeadline } from "../../shared/executable/query.js";
import type { ListModelsResult, ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { DSH_READY_TIMEOUT_MS, DshCommandError, dshControl } from "./control.js";
import { dshEnvironment, launchDsh } from "./launch.js";
import { readExecutableVersion } from "../../shared/executable/index.js";
import { dshVersionUnsupported } from "./version.js";

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

/** Classify DSH's native `models` catalog without inspecting environment variables. */
export function dshCatalogResult(catalog: JsonRecord): ListModelsResult {
  const models = projectDshModels(catalog);
  if (models.length > 0) {
    return { kind: "ok", models };
  }
  const providers = asRecordList(catalog.providers);
  const selected = asRecord(catalog.default);
  const defaultProvider = typeof selected?.provider === "string" && selected.provider.length > 0 ? selected.provider : undefined;
  if (defaultProvider !== undefined) {
    const entry = providers.find((provider) => provider.id === defaultProvider);
    if (entry !== undefined && typeof entry.failure !== "string" && asRecordList(entry.models).length === 0) {
      const defaultModel = typeof selected?.model === "string" && selected.model.length > 0 ? selected.model : undefined;
      const target = defaultModel === undefined ? `"${defaultProvider}"` : `"${defaultProvider}" (${defaultProvider}/${defaultModel})`;
      return {
        kind: "unauthenticated",
        detail: `DSH default provider ${target} listed no models; configure credentials for ${defaultProvider}.`,
      };
    }
  }
  const failures = providers.flatMap((provider) => typeof provider.failure === "string" ? [`${String(provider.id)}: ${provider.failure}`] : []);
  if (failures.length > 0) {
    return { kind: "unsupported", reason: `DSH could not list any provider's models: ${failures.join("; ")}` };
  }
  return { kind: "ok", models };
}

/** Native `llm.listProviders`, `listModels` and `resolveModelInfo`, in a short-lived process started the way a session is. */
export const dshListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "DSH model listing requires its executable" }; }
  const timeoutMs = options.timeoutMs ?? DSH_READY_TIMEOUT_MS;
  const result = await withQueryDeadline<ListModelsResult>("DSH model listing", timeoutMs, async (signal, own) => {
    const env = dshEnvironment(options.env);
    const version = installation.version ?? await readExecutableVersion(installation.command, options.timeoutMs ?? 15_000, undefined, env, signal);
    signal.throwIfAborted();
    const refusal = dshVersionUnsupported(version);
    if (refusal !== null) { return refusal; }
    const launched = await launchDsh(installation.command, listingCwd(options), env, { signal });
    own(launched.child);
    const control = dshControl(launched.child, () => {});
    try {
      await control.ready;
      launched.profileOpened();
      const catalog = await control.request("models", {}, options.timeoutMs);
      return dshCatalogResult(catalog);
    } catch (error) {
      if (error instanceof DshCommandError && error.code === "native_method_unavailable") { return { kind: "unsupported", reason: error.message }; }
      throw error;
    }
  });
  return result;
};
