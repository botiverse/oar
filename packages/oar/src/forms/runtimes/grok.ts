import type { RuntimeConfigForm } from "../types.js";

/**
 * Grok's form: a listed model (no default, no typed id, as Raft offers today)
 * and the reasoning effort the chosen model lists. A launch also accepts what
 * Raft's driver accepts today (`launchModes`).
 */
export const grokConfigForm: RuntimeConfigForm = {
  protocol: 1,
  runtime: "grok",
  fields: [
    {
      id: "model",
      kind: "model",
      modes: ["preset"],
      // Raft's Grok driver launches a stored typed model (older column-only rows
      // hydrate as custom) and "default" as the runtime's own default.
      launchModes: ["inherit", "preset", "custom"],
      required: true,
      label: { key: "runtime_form.grok.model.label", en: "Model" },
      hint: { key: "runtime_form.grok.model.hint", en: "Models available from this computer's Grok CLI." },
    },
    {
      id: "reasoningEffort",
      kind: "effort",
      modelField: "model",
      required: false,
      label: { key: "runtime_form.grok.reasoning_effort.label", en: "Reasoning" },
      hint: { key: "runtime_form.grok.reasoning_effort.hint", en: "Available values depend on the selected model." },
    },
  ],
};

/**
 * The form a machine that sends no capability report gets: frozen in the
 * migration that moved Grok's form into OAR and never changed afterwards.
 * A separate literal on purpose: editing `grokConfigForm` must not change what
 * old daemons receive (tests pin this copy).
 */
export const grokBaselineForm: RuntimeConfigForm = {
  protocol: 1,
  runtime: "grok",
  fields: [
    {
      id: "model",
      kind: "model",
      modes: ["preset"],
      // Raft's Grok driver launches a stored typed model (older column-only rows
      // hydrate as custom) and "default" as the runtime's own default.
      launchModes: ["inherit", "preset", "custom"],
      required: true,
      label: { key: "runtime_form.grok.model.label", en: "Model" },
      hint: { key: "runtime_form.grok.model.hint", en: "Models available from this computer's Grok CLI." },
    },
    {
      id: "reasoningEffort",
      kind: "effort",
      modelField: "model",
      required: false,
      label: { key: "runtime_form.grok.reasoning_effort.label", en: "Reasoning" },
      hint: { key: "runtime_form.grok.reasoning_effort.hint", en: "Available values depend on the selected model." },
    },
  ],
};
