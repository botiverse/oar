import type { ConfigField, ConfigIssue, FormValues, LaunchValues, ModelValue, RuntimeConfigForm } from "./types.js";

/** A field participates only when every controlling field is itself visible. */
export function activeFields(form: RuntimeConfigForm, values: FormValues | LaunchValues): readonly ConfigField[] {
  const byId = new Map(form.fields.map(field => [field.id, field]));
  return form.fields.filter(field => {
    const seen = new Set<string>();
    let parent = field.visibleWhen;
    while (parent !== undefined) {
      const value = values[parent.field];
      const controller = byId.get(parent.field);
      if (controller === undefined || seen.has(parent.field) || typeof value !== "string" || !parent.in.includes(value)) { return false; }
      seen.add(parent.field);
      parent = controller.visibleWhen;
    }
    return true;
  });
}

/** Each supplied model or effort maps to one shared launch option. */
export function mappingConflicts(fields: readonly ConfigField[], values: FormValues | LaunchValues): ConfigIssue[] {
  const supplied = new Set<string>();
  const issues: ConfigIssue[] = [];
  for (const field of fields) {
    if ((field.kind === "model" || field.kind === "effort") && !isEmpty(values[field.id])) {
      if (supplied.has(field.kind)) { issues.push({ field: field.id, code: "conflicting_fields" }); }
      supplied.add(field.kind);
    }
  }
  return issues;
}

export function scalarIssue(field: ConfigField, value: unknown): ConfigIssue["code"] | null {
  if (field.kind === "boolean") { return typeof value === "boolean" ? null : "invalid_shape"; }
  if (typeof value !== "string") { return "invalid_shape"; }
  if (field.kind === "select" && !field.options.some(option => option.value === value)) { return "option_not_offered"; }
  if (field.kind === "text" && field.format === "url" && !URL.canParse(value)) { return "invalid_shape"; }
  return null;
}

function readString(value: object, key: string): string | undefined {
  const entry: unknown = Reflect.get(value, key);
  return typeof entry === "string" && entry.trim() !== "" ? entry : undefined;
}

/** A model value of a known shape, or null for anything else. */
export function asModelValue(value: unknown): ModelValue | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "inherit") {
    return { kind: "inherit" };
  }
  const id = readString(value, "id");
  if (kind === "preset" && id !== undefined) {
    return { kind: "preset", id };
  }
  const name = readString(value, "name");
  if (kind === "custom" && name !== undefined) {
    return { kind: "custom", name };
  }
  return null;
}

export function sameModel(left: unknown, right: unknown): boolean {
  const a = asModelValue(left);
  const b = asModelValue(right);
  if (a === null || b === null) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function unknownFieldIds(form: RuntimeConfigForm, values: FormValues | LaunchValues): readonly string[] {
  return Object.keys(values).filter((id) => !form.fields.some((field) => field.id === id));
}

export function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
