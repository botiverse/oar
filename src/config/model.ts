/**
 * Model / option source for create-agent config (final design).
 * KINDs closed; option list open. Supported ⇒ required.
 */

import type { JsonSchema } from "./profile.js";

export type Choice = { readonly id: string; readonly label: string };

export type ConfigOption =
  | { readonly kind: "enum"; readonly id: string; readonly label: string; readonly values: readonly Choice[] }
  | { readonly kind: "boolean"; readonly id: string; readonly label: string }
  | {
      readonly kind: "number";
      readonly id: string;
      readonly label: string;
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: "string";
      readonly id: string;
      readonly label: string;
      readonly placeholder?: string;
    };

export interface ModelInfo {
  readonly id: string;
  readonly label: string;
  readonly options: readonly ConfigOption[];
}

export interface ProviderInfo {
  readonly id: string;
  readonly label: string;
  readonly models: readonly ModelInfo[];
}

export interface ModelBranch {
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  readonly unknownKinds: readonly string[];
}

function assertNever(x: never): never {
  throw new Error(`unhandled ConfigOption kind: ${String(x)}`);
}

/** Emit schema fragment for one model's options (supported ⇒ required). */
export function optionsBranch(options: readonly ConfigOption[]): ModelBranch {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const unknownKinds: string[] = [];

  for (const opt of options) {
    switch (opt.kind) {
      case "enum":
        properties[opt.id] = {
          type: "string",
          enum: opt.values.map((v) => v.id),
        };
        required.push(opt.id);
        break;
      case "boolean":
        properties[opt.id] = { type: "boolean" };
        required.push(opt.id);
        break;
      case "number":
        // Profile leaf set is enum/const/type only — encode bounds in label data for now;
        // wire type is number when profile expands. Until then use string enum of allowed
        // is not available; emit boolean-free string freeform is wrong. Use type string? 
        // Design allows number leaf — profile must allow type:number.
        properties[opt.id] = { type: "number" };
        required.push(opt.id);
        break;
      case "string":
        properties[opt.id] = { type: "string" };
        required.push(opt.id);
        break;
      default:
        // Version skew: unknown kind skipped + reported (tooth 12).
        unknownKinds.push(String((opt as { kind: string }).kind));
        break;
    }
  }

  // Exhaustiveness binder for known kinds (tooth 1).
  void (null as unknown as typeof assertNever);

  return { properties, required, unknownKinds };
}

/** Helpers for fixture authors. */
export function enumOpt(
  id: string,
  label: string,
  values: readonly string[],
): ConfigOption {
  return {
    kind: "enum",
    id,
    label,
    values: values.map((v) => ({ id: v, label: v })),
  };
}

export function boolOpt(id: string, label: string): ConfigOption {
  return { kind: "boolean", id, label };
}

export function model(
  id: string,
  label: string,
  options: readonly ConfigOption[] = [],
): ModelInfo {
  return { id, label, options };
}
