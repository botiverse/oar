import type { AuthMode } from "./auth.js";

/**
 * CONFIG OPTIONS — what a caller fills in BEFORE start.
 *
 * Deliberately a separate record from `Capabilities`. The membership test:
 *
 *   branch on it while driving a session  -> capability
 *   decide it before starting             -> config option (here)
 *
 * This is the record a create-agent form is generated from, and generating
 * that form is the acceptance test for whether the record is complete: if the
 * form cannot be derived from it, the model is underspecified. That check is
 * worth more than self-assessment, because something other than the author
 * decides it.
 */

/**
 * An option's admissible values are RESOLVED, not constant.
 *
 * In the extraction source, reasoning effort is gated first by runtime and
 * again by the selected model -- `max`/`ultra` exist only for models that
 * declare them. So a static per-runtime table is the wrong shape: choosing a
 * runtime is not enough, changing the model must RE-RESOLVE the options.
 */
export interface OptionResolution {
  readonly runtime: string;
  readonly model?: string;
}

/** A closed choice. `allowed` is resolved per `OptionResolution`. */
export interface EnumOption {
  readonly kind: "enum";
  readonly id: string;
  readonly required: boolean;
  readonly allowed: readonly string[];
}

export interface BooleanOption {
  readonly kind: "boolean";
  readonly id: string;
  readonly required: boolean;
}

/**
 * The auth block. Modelled as its own option kind rather than a set of fields
 * because runtimes differ in the SHAPE of authentication, not the number of
 * inputs -- two arms, three arms, or must-be-absent.
 */
export interface AuthOption {
  readonly kind: "auth";
  readonly id: string;
  readonly required: boolean;
  readonly modes: readonly AuthMode[];
}

export type ConfigOption = EnumOption | BooleanOption | AuthOption;

/**
 * What a runtime declares. A form is generated from this; nothing is
 * hand-maintained per runtime.
 *
 * `unsupported` is explicit rather than an omission: an option a runtime
 * REJECTS is different from one it has not been asked about, and a blank
 * cannot express the difference.
 */
export interface ConfigSchema {
  readonly options: readonly ConfigOption[];
  readonly unsupported: readonly string[];
}
