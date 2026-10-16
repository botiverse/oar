import { asModelValue, isActive, isEmpty, unknownFieldIds } from "./fields.js";
import type { ConfigField, ConfigIssue, LaunchValue, LaunchValues, RuntimeConfigForm } from "./types.js";
import type { SessionOptions } from "../contracts/session-options.js";

/** The `SessionOptions` members a form maps; everything else stays the host's. */
export type FormSessionOptions = Partial<Pick<SessionOptions, "model" | "effort">>;

/** What one field contributes to a launch. */
type Contribution =
  | { readonly issue: ConfigIssue["code"] }
  | { readonly model: string }
  | { readonly effort: string }
  | { readonly unmapped: string | boolean }
  | Record<string, never>;

export type SessionMapping =
  | {
      readonly ok: true;
      readonly options: FormSessionOptions;
      /**
       * Active select, text and boolean values, by field id. They have no shared
       * `SessionOptions` member, so they are handed back for the runtime's own
       * mapping instead of being dropped; the caller must apply or refuse them.
       */
      readonly unmapped: Readonly<Record<string, string | boolean>>;
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

function modelContribution(field: ConfigField & { kind: "model" }, value: LaunchValue | undefined): Contribution {
  const model = asModelValue(value);
  if (model === null) {
    return { issue: "invalid_shape" };
  }
  if (!field.modes.includes(model.kind)) {
    return { issue: "mode_not_allowed" };
  }
  if (model.kind === "preset") {
    return { model: model.id };
  }
  return model.kind === "custom" ? { model: model.name } : {};
}

function isPresentSecret(value: LaunchValue | undefined): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "present") === true;
}

function contribution(field: ConfigField, value: LaunchValue | undefined): Contribution {
  if (field.kind === "secret") {
    return field.required && !isPresentSecret(value) ? { issue: "secret_missing" } : {};
  }
  if (isEmpty(value)) {
    return field.required ? { issue: "required" } : {};
  }
  if (field.kind === "model") {
    return modelContribution(field, value);
  }
  if (typeof value !== "string" && typeof value !== "boolean") {
    return { issue: "invalid_shape" };
  }
  if (field.kind === "effort") {
    return typeof value === "string" ? { effort: value } : { issue: "invalid_shape" };
  }
  return { unmapped: value };
}

/**
 * Resolved launch values to session options (docs/spec/config-form.md,
 * "Launch mapping"). Pure: credentials arrive already resolved by the host.
 * Inactive branches never launch; a value outside the form's declared modes
 * is refused, never dropped; a required secret that resolves to nothing is
 * `secret_missing`, never an empty option.
 */
export function toSessionOptions(form: RuntimeConfigForm, values: LaunchValues): SessionMapping {
  const issues: ConfigIssue[] = unknownFieldIds(form, values).map((id) => ({ field: id, code: "unknown_field" }));
  const options: { model?: string; effort?: string } = {};
  const unmapped: Record<string, string | boolean> = {};
  for (const field of form.fields.filter((candidate) => isActive(candidate, values))) {
    const part = contribution(field, values[field.id]);
    if ("issue" in part) {
      issues.push({ field: field.id, code: part.issue });
    } else if ("model" in part) {
      options.model = part.model;
    } else if ("effort" in part) {
      options.effort = part.effort;
    } else if ("unmapped" in part) {
      unmapped[field.id] = part.unmapped;
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, options, unmapped };
}
