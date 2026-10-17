import type { RuntimeConfigForm } from "../types.js";

/**
 * Grok's form, as the runtime accepts it: its own default model, a listed
 * model or a typed id, and the reasoning effort the chosen model lists. A host
 * that offers less narrows this form itself.
 */
export const grokConfigForm: RuntimeConfigForm = {
  protocol: 1,
  runtime: "grok",
  fields: [
    {
      id: "model",
      kind: "model",
      modes: ["inherit", "preset", "custom"],
      required: false,
      label: { key: "runtime_form.grok.model.label", en: "Model" },
      hint: { key: "runtime_form.grok.model.hint", en: "Models available from this computer's Grok CLI. A typed model id the CLI does not know fails when the agent starts." },
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
 * The form a machine that sends no capability report gets: frozen at the
 * first release that carries Grok's form and never changed afterwards.
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
      modes: ["inherit", "preset", "custom"],
      required: false,
      label: { key: "runtime_form.grok.model.label", en: "Model" },
      hint: { key: "runtime_form.grok.model.hint", en: "Models available from this computer's Grok CLI. A typed model id the CLI does not know fails when the agent starts." },
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
