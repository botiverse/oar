import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import type { AcpModelConfigurationContext } from "../../shared/acp/model-configuration.js";
import { acpReportedModel, acpReportedEffort, acpThoughtLevelOption } from "../../shared/acp/model.js";
import { asRecordList, type JsonRecord } from "../../shared/json.js";

function selectors(response: JsonRecord): string[] {
  const option = asRecordList(response.configOptions).find(entry => entry.id === "model");
  return [...new Set(asRecordList(option?.options).flatMap(entry => typeof entry.value === "string" ? [entry.value] : []))];
}

function refusal(requested: string, response: JsonRecord, catalog: readonly string[]): ModelConfirmationError {
  const effort = acpReportedEffort(response), reported = acpReportedModel(response);
  return new ModelConfirmationError(`Antigravity could not confirm model ${requested}; native model=${reported ?? "unreported"}, thought_level=${effort ?? "unreported"}`, {
    requested, reported, catalogSelectorIds: catalog,
  });
}

/** Old catalogs combined model and effort; ACP now carries two confirmed settings. */
export async function configureAntigravityModel(context: AcpModelConfigurationContext): Promise<JsonRecord | undefined> {
  const { options, response, setModel, setEffort } = context;
  const catalog = selectors(response), requested = options.model;
  if (requested === undefined || catalog.includes(requested)) {
    const selected = requested === undefined ? undefined : await setModel(requested);
    if (options.effort !== undefined) { await setEffort(options.effort, selected); }
    return selected;
  }
  // Do not use the current model's effort menu for a different model. First
  // require one unambiguous native model prefix, then read its own menu.
  const candidates = catalog.filter(model => requested.startsWith(`${model}-`) && requested.length > model.length + 1);
  const model = candidates[0];
  if (candidates.length !== 1 || model === undefined) { throw refusal(requested, response, catalog); }
  const effort = requested.slice(model.length + 1);
  if (options.effort !== undefined && options.effort !== effort) {
    throw new UnsupportedOptionError("effort", `effort ${options.effort} conflicts with ${effort} in model ${requested}`);
  }
  let selected: JsonRecord | undefined = undefined;
  try { selected = await setModel(model); }
  catch (error) {
    if (error instanceof ModelConfirmationError) {
      throw new ModelConfirmationError(error.message, { requested, reported: error.reported, catalogSelectorIds: catalog, cause: error });
    }
    throw error;
  }
  const menu = selected ?? {};
  const levels = asRecordList(acpThoughtLevelOption(menu)?.options);
  if (acpReportedModel(menu) !== model || !levels.some(entry => entry.value === effort)) { throw refusal(requested, menu, catalog); }
  const applied = await setEffort(effort, selected);
  if (acpReportedModel(applied) !== model || acpReportedEffort(applied) !== effort) { throw refusal(requested, applied, catalog); }
  return selected;
}
