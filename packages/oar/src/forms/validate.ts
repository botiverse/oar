import { asModelValue, isActive, isEmpty, sameModel, unknownFieldIds } from "./fields.js";
import type { ConfigField, ConfigIssue, EffortField, FormValue, FormValues, ModelField, RuntimeConfigForm, SecretField, ValidationContext } from "./types.js";
import type { ModelEntry } from "../contracts/list-models.js";
import { listedModels } from "./listing.js";

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
    return "mode_not_allowed";
  }
  if (model.kind !== "preset" || check.models.some((entry) => entry.id === model.id)) {
    return null;
  }
  // Preservation: the stored preset stays valid when the listing cannot name it.
  const preserved = check.stored !== undefined && sameModel(check.stored[field.id], model);
  return preserved ? null : "model_not_listed";
}

function checkEffort(field: EffortField, check: FieldCheck): IssueCode {
  const missing = presence(field, check.value);
  if (missing !== undefined) {
    return missing;
  }
  if (typeof check.value !== "string") {
    return "invalid_shape";
  }
  const model = asModelValue(check.values[field.modelField]);
  const entry = model?.kind === "preset" ? check.models.find((candidate) => candidate.id === model.id) : undefined;
  if (entry?.effortLevels?.includes(check.value) === true) {
    return null;
  }
  // Unknown levels offer nothing; only an unchanged stored effort on an unchanged model is kept.
  const { stored } = check;
  const preserved = entry === undefined && stored !== undefined && stored[field.id] === check.value
    && sameModel(stored[field.modelField], check.values[field.modelField]);
  return preserved ? null : "effort_not_offered";
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
  if (field.kind === "secret") {
    return checkSecret(field, check);
  }
  return checkScalar(field, check);
}

/**
 * Validate submitted values (docs/spec/config-form.md, "Validation").
 * Preservation: on edit, a stored preset or effort is not rejected only because
 * the listing could not enumerate it. Launch validity (shape, declared modes and
 * options, required fields) applies to every value, stored or new. Inactive
 * branches are not checked for presence.
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
