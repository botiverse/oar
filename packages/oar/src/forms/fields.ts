import type { ConfigField, FormValues, LaunchValues, ModelValue, RuntimeConfigForm } from "./types.js";

/** False when the field's `visibleWhen` is not met: an inactive branch, not part of this configuration. */
export function isActive(field: ConfigField, values: FormValues | LaunchValues): boolean {
  if (field.visibleWhen === undefined) {
    return true;
  }
  const other = values[field.visibleWhen.field];
  return typeof other === "string" && field.visibleWhen.in.includes(other);
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
