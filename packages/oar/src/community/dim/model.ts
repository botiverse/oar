import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import type { AcpModelConfiguration } from "../../shared/acp/model-configuration.js";
import { acpReportedModel } from "../../shared/acp/model.js";
import { asRecordList, type JsonRecord } from "../../shared/json.js";

/** Dim publishes a `model` option only for a model in its provider catalog (a `--model-config` file has none). */
export function hasDimModelOption(response: JsonRecord): boolean {
  return asRecordList(response.configOptions).some((option) => option.id === "model");
}

/**
 * `model` is the bare catalog id the `model` option lists; `effort` is its
 * `thought_level` option, which Dim publishes only for a model that declares
 * reasoning. The shared effort step refuses a session without one.
 */
export const dimConfigureModel: AcpModelConfiguration = async ({ options, response, setModel, setEffort }) => {
  const applied = options.model === undefined ? undefined : await applyDimModel(options.model, response, setModel);
  if (options.effort !== undefined) { await setEffort(options.effort, applied); }
  return applied;
};

async function applyDimModel(
  model: string,
  response: JsonRecord,
  setModel: (model: string) => Promise<JsonRecord | undefined>,
): Promise<JsonRecord | undefined> {
  if (!hasDimModelOption(response)) {
    throw new UnsupportedOptionError("model", "this Dim session advertises no model config option (a --model-config file is not a provider catalog)");
  }
  const applied = await setModel(model);
  const reported = acpReportedModel(applied ?? null);
  if (reported !== model) {
    throw new ModelConfirmationError(`session/set_config_option left model at ${reported ?? "an unreported value"} although ${model} was requested`, { requested: model, reported });
  }
  return applied;
}
