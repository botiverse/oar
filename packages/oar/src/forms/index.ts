/**
 * `@botiverse/oar/forms`: runtime config forms as plain data plus pure
 * validation and launch mapping (docs/spec/config-form.md). Loads no runtime
 * SDK and does nothing on import; tests/config-form.test.ts bundles it to check.
 */
import { grokBaselineForm, grokConfigForm } from "./runtimes/grok.js";
import type { RuntimeConfigForm } from "./types.js";

export type * from "./types.js";
export { toModelListing, listedModels, type ListingFailure } from "./listing.js";
export { isActive } from "./fields.js";
export { validateConfig } from "./validate.js";
export { toSessionOptions, type FormSessionOptions, type SessionMapping } from "./map.js";

/** Every runtime with a migrated form, by `Runtime.id`. A runtime without one has no entry. */
export const configForms: Readonly<Record<string, RuntimeConfigForm>> = Object.freeze({
  grok: grokConfigForm,
});

/** The frozen form served to a machine that reports no capabilities. */
export const baselineForms: Readonly<Record<string, RuntimeConfigForm>> = Object.freeze({
  grok: grokBaselineForm,
});
