import { asModelValue, isActive, isEmpty, sameModel, unknownFieldIds } from "./fields.js";
import type { ConfigField, ConfigIssue, EffortField, FormValue, FormValues, ModelField, RuntimeConfigForm, SecretField, ServiceTierField, ValidationContext } from "./types.js";
import type { ModelEntry } from "../contracts/list-models.js";
import { listedModels } from "./listing.js";
import { serviceTierChoices } from "./service-tier.js";

type IssueCode = ConfigIssue["code"] | null;

/** What one field's check sees. */
interface FieldCheck {
  readonly value: FormValue | undefined;
  readonly values: FormValues;
  readonly models: readonly ModelEntry[];
  /** The values stored before this edit; undefined on create. */
  readonly stored: FormValues | undefined;
  readonly mode: ValidationContext["mode"];
}

function presence(field: ConfigField, value: FormValue | undefined): IssueCode | undefined {
  if (!isEmpty(value)) {
    return undefined;
  }
  return field.required ? "required" : null;
}

function checkModel(field: ModelField, check: FieldCheck): IssueCode {
  const missing = presence(field, check.value);
  if (missing !== undefined) {
    return missing;
  }
  const model = asModelValue(check.value);
  if (model === null) {
    return "invalid_shape";
  }
  if (!field.modes.includes(model.kind)) {
    // Preservation: an edit may keep an unchanged stored value the form no
    // longer offers, as long as a launch still accepts its mode.
    const launchable = (field.launchModes ?? field.modes).includes(model.kind);
    const kept = launchable && check.stored !== undefined && sameModel(check.stored[field.id], model);
    return kept ? null : "mode_not_allowed";
  }
  if (model.kind !== "preset") {
    return null;
  }
  const entry = check.models.find((candidate) => candidate.id === model.id);
  if (entry !== undefined && entry.disabled === undefined) {
    return null;
  }
  // Preservation: the stored preset stays valid when the listing cannot name it or disables it.
  const preserved = check.stored !== undefined && sameModel(check.stored[field.id], model);
  if (preserved) {
    return null;
  }
  return entry === undefined ? "model_not_listed" : "model_disabled";
}

/**
 * The listing entry a model value runs as: the named preset, or the entry
 * marked default for `inherit` and for an empty (optional) model, which
 * launches exactly like `inherit`.
 */
function runningEntry(value: FormValue | undefined, models: readonly ModelEntry[]): ModelEntry | undefined {
  const model = asModelValue(value);
  if (model?.kind === "preset") {
    return models.find((candidate) => candidate.id === model.id);
  }
  const runsAsDefault = model?.kind === "inherit" || isEmpty(value);
  return runsAsDefault ? models.find((candidate) => candidate.default === true) : undefined;
}

/**
 * Preservation for a value bound to a model field (effort, service tier): an
 * unchanged stored value on an unchanged model is kept, whatever the listing
 * now says, because the entry a model runs as (the runtime's default above all)
 * can move. Both left empty is an unchanged model too (an empty model runs as
 * the default).
 */
function keptOnSameModel(field: EffortField | ServiceTierField, check: FieldCheck): boolean {
  const { stored } = check;
  const storedModel = stored?.[field.modelField];
  const model = check.values[field.modelField];
  const modelUnchanged = sameModel(storedModel, model) || (isEmpty(storedModel) && isEmpty(model));
  return stored !== undefined && stored[field.id] === check.value && modelUnchanged;
}

function checkEffort(field: EffortField, check: FieldCheck): IssueCode {
  const missing = presence(field, check.value);
  if (missing !== undefined) {
    return missing;
  }
  if (typeof check.value !== "string") {
    return "invalid_shape";
  }
  const entry = runningEntry(check.values[field.modelField], check.models);
  if (entry?.effortLevels?.includes(check.value) === true) {
    return null;
  }
  return keptOnSameModel(field, check) ? null : "effort_not_offered";
}

/** Effort's rules for a tier: a new one must be offered by the entry the model value runs as (`serviceTierChoices`). */
function checkServiceTier(field: ServiceTierField, check: FieldCheck): IssueCode {
  const missing = presence(field, check.value);
  if (missing !== undefined) {
    return missing;
  }
  if (typeof check.value !== "string") {
    return "invalid_shape";
  }
  const entry = runningEntry(check.values[field.modelField], check.models);
  if (serviceTierChoices(entry).values.includes(check.value)) {
    return null;
  }
  return keptOnSameModel(field, check) ? null : "service_tier_not_offered";
}

function secretKind(value: FormValue | undefined): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "set") {
    const secret: unknown = Reflect.get(value, "value");
    return typeof secret === "string" && secret !== "" ? "set" : undefined;
  }
  return kind === "unset" || kind === "keep" || kind === "clear" ? kind : undefined;
}

function checkSecret(field: SecretField, check: FieldCheck): IssueCode {
  const creating = check.mode === "create";
  if (check.value === undefined || check.value === null) {
    return field.required && creating ? "required" : null;
  }
  const kind = secretKind(check.value);
  if (kind === undefined) {
    return "invalid_shape";
  }
  if (!field.required || kind === "set") {
    return null;
  }
  // A required secret: create needs a new one; an edit may keep it, never clear or leave it unset.
  return kind === "keep" && !creating ? null : "required";
}

function checkScalar(field: ConfigField, check: FieldCheck): IssueCode {
  const missing = presence(field, check.value);
  if (missing !== undefined) {
    return missing;
  }
  if (field.kind === "boolean") {
    return typeof check.value === "boolean" ? null : "invalid_shape";
  }
  if (typeof check.value !== "string") {
    return "invalid_shape";
  }
  if (field.kind === "select") {
    const { value } = check;
    return field.options.some((option) => option.value === value) ? null : "option_not_offered";
  }
  return null;
}

function checkField(field: ConfigField, check: FieldCheck): IssueCode {
  if (field.kind === "model") {
    return checkModel(field, check);
  }
  if (field.kind === "effort") {
    return checkEffort(field, check);
  }
  if (field.kind === "serviceTier") {
    return checkServiceTier(field, check);
  }
  if (field.kind === "secret") {
    return checkSecret(field, check);
  }
  return checkScalar(field, check);
}

/**
 * Validate submitted values (docs/spec/config-form.md, "Validation").
 * Preservation: on edit, a stored preset, effort or service tier is not
 * rejected only because the listing could not enumerate it. Launch validity
 * (shape, declared modes and options, required fields) applies to every value,
 * stored or new. Inactive branches are not checked for presence.
 */
export function validateConfig(form: RuntimeConfigForm, values: FormValues, context: ValidationContext): readonly ConfigIssue[] {
  const unknown = unknownFieldIds(form, values).map((id): ConfigIssue => ({ field: id, code: "unknown_field" }));
  const models = listedModels(context.models);
  const stored = context.mode === "edit" ? context.stored : undefined;
  const { mode } = context;
  const fieldIssues = form.fields
    .filter((field) => isActive(field, values))
    .map((field) => ({ field: field.id, code: checkField(field, { value: values[field.id], values, models, stored, mode }) }))
    .filter((issue): issue is ConfigIssue => issue.code !== null);
  return [...unknown, ...fieldIssues];
}
