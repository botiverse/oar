import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import type { AcpModelConfiguration } from "../../shared/acp/model-configuration.js";
import { acpReportedModel } from "../../shared/acp/model.js";
import type { JsonRecord } from "../../shared/json.js";

/**
 * `model` is a `provider:model` id the `model` option lists (BUB_MODEL, its
 * fallbacks and the provider's model listing); `effort` is the
 * `reasoning_effort` option (category `thought_level`). Bub answers each
 * setting with the full option list, so the answer confirms it.
 */
export const bubConfigureModel: AcpModelConfiguration = async ({ options, setModel, setEffort }) => {
  const applied = options.model === undefined ? undefined : await applyBubModel(options.model, setModel);
  if (options.effort !== undefined) { await setEffort(options.effort, applied); }
  return applied;
};

async function applyBubModel(model: string, setModel: (model: string) => Promise<JsonRecord | undefined>): Promise<JsonRecord | undefined> {
  const applied = await setModel(model);
  const reported = acpReportedModel(applied ?? null);
  if (reported !== model) {
    throw new ModelConfirmationError(`session/set_config_option left model at ${reported ?? "an unreported value"} although ${model} was requested`, { requested: model, reported });
  }
  return applied;
}
