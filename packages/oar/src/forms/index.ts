/**
 * `@botiverse/oar/forms`: runtime config forms as plain data
 * for host validation and launch mapping (docs/spec/config-form.md). Loads no runtime
 * SDK and does nothing on import; tests/config-form.test.ts bundles it to check.
 */
import { grokConfigForm } from "./runtimes/grok.js";
import type { RuntimeConfigForm } from "./types.js";

export type * from "./types.js";

/** Every runtime with a migrated form, by `Runtime.id`. A runtime without one has no entry. */
export const configForms: Readonly<Record<string, RuntimeConfigForm>> = Object.freeze({
  grok: grokConfigForm,
});
