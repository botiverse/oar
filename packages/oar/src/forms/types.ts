/**
 * Runtime config form: what creating an agent for a runtime asks for, as plain
 * data a host can serialize (docs/spec/config-form.md). Type-only imports keep
 * this entry free of runtime code.
 */
import type { ModelEntry } from "../contracts/list-models.js";

export interface CopyText {
  /** Stable translation key; never changes with the English text. */
  readonly key: string;
  /** English default, used when the host has no translation for `key`. */
  readonly en: string;
}

interface FieldBase {
  /** Stable id; never changes with its copy. */
  readonly id: string;
  readonly label: CopyText;
  readonly hint?: CopyText;
  readonly required: boolean;
  /** Shown only when another field has one of these values (inactive branch otherwise). */
  readonly visibleWhen?: { readonly field: string; readonly in: readonly string[] };
}

export type ModelMode = "inherit" | "preset" | "custom";

/** Options from `Runtime.listModels` on the machine that will run the agent. */
export interface ModelField extends FieldBase {
  readonly kind: "model";
  /** The selections the form offers; `validateConfig` enforces it on submit. */
  readonly modes: readonly ModelMode[];
  /**
   * The selections a launch accepts, when wider than what the form offers: a
   * stored value the form no longer offers (an older create path, an API) can
   * still launch. Declared from what the runtime's launch path is verified to
   * accept; it maps a value to launch options and does not promise the
   * provider accepts that model id. Defaults to `modes`; a mode in neither is
   * refused by `toSessionOptions`.
   */
  readonly launchModes?: readonly ModelMode[];
}

/** Options from the chosen model's `ModelEntry.effortLevels`. */
export interface EffortField extends FieldBase {
  readonly kind: "effort";
  readonly modelField: string;
}

export interface SelectField extends FieldBase {
  readonly kind: "select";
  readonly options: readonly { readonly value: string; readonly label: CopyText }[];
}

/** Write-only: a stored value is never read back into the form. */
export interface SecretField extends FieldBase { readonly kind: "secret" }
export interface TextField extends FieldBase { readonly kind: "text"; readonly format?: "url" }
export interface BooleanField extends FieldBase { readonly kind: "boolean" }

export type ConfigField = ModelField | EffortField | SelectField | SecretField | TextField | BooleanField;

export interface RuntimeConfigForm {
  readonly protocol: 1;
  /** The `Runtime.id` it describes. */
  readonly runtime: string;
  readonly fields: readonly ConfigField[];
}

export type ModelValue =
  | { readonly kind: "inherit" }
  | { readonly kind: "preset"; readonly id: string }
  | { readonly kind: "custom"; readonly name: string };

/** What a form submits for a secret field: an edit the host applies, not a credential. */
export type SecretEdit =
  | { readonly kind: "unset" }
  | { readonly kind: "keep" }
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly value: string };

export type FormValue = ModelValue | SecretEdit | string | boolean | null;
export type FormValues = Readonly<Record<string, FormValue>>;

/** A credential the host resolved at the launch boundary. */
export type ResolvedSecret =
  | { readonly present: true; readonly value: string }
  | { readonly present: false };

export type LaunchValue = ModelValue | ResolvedSecret | string | boolean | null;
export type LaunchValues = Readonly<Record<string, LaunchValue>>;

export type ListingReason = "unauthenticated" | "timeout" | "failed" | "empty" | "machine_offline" | "unsupported";

export type ModelListing =
  | { readonly status: "live"; readonly models: readonly ModelEntry[] }
  | { readonly status: "fallback"; readonly source: "bundled"; readonly reason: ListingReason; readonly models: readonly ModelEntry[] }
  | { readonly status: "unavailable"; readonly reason: ListingReason };

export interface ConfigIssue {
  readonly field: string;
  /** Stable key; hosts translate it. */
  readonly code:
    | "required"
    | "invalid_shape"
    | "mode_not_allowed"
    | "model_not_listed"
    | "model_disabled"
    | "effort_not_offered"
    | "option_not_offered"
    | "secret_missing"
    | "unknown_field";
}

/** Create has nothing stored; an edit must say what was stored, so a missing `stored` cannot pass as a create. */
export type ValidationContext =
  | { readonly mode: "create"; readonly models: ModelListing }
  | {
      readonly mode: "edit";
      /** The values stored before this edit, as the host has them. */
      readonly stored: FormValues;
      readonly models: ModelListing;
    };
