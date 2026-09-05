/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-return -- Standalone untyped fixture module for fake-acp-agent.mjs. */
// The model the fixture "really" runs, regardless of what was requested: the
// silent-fallback shape both real agents have (grok falls back to the default
// when the requested model is not allowed; kimi keeps its own current id).
// Reported in both upstream spellings: kimi's configOptions row and grok's
// models.currentModelId.
const EFFECTIVE_MODEL = "fixture-model-x";

function modelOption(currentValue) {
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue,
    options: [
      { value: EFFECTIVE_MODEL, name: "Fixture X" },
      { value: "requested-y", name: "Requested Y" },
    ],
  };
}

export function modelReport() {
  return {
    configOptions: [modelOption(EFFECTIVE_MODEL)],
    models: {
      currentModelId: EFFECTIVE_MODEL,
      availableModels: [
        { modelId: EFFECTIVE_MODEL, name: "Fixture X" },
        { modelId: "requested-y", name: "Requested Y" },
      ],
    },
  };
}

function pushedModel(currentValue) {
  return { sessionUpdate: "config_option_update", configOptions: [modelOption(currentValue)] };
}

/**
 * What `session/set_model <modelId>` does. `grok-meta`: the applied model
 * rides in the response `_meta` (xai-grok-shell). `kimi-push`: a
 * config_option_update is emitted BEFORE the request is answered, and the
 * answer itself is empty (kimi-code). Anything else: accepted with an empty
 * answer while the fixture keeps running EFFECTIVE_MODEL.
 */
export function setModelResponse(modelId) {
  if (modelId === "grok-meta") {
    return { response: { _meta: { model: "grok-applied" } } };
  }
  if (modelId === "kimi-push") {
    return { pushedUpdate: pushedModel("kimi-pushed"), response: {} };
  }
  if (modelId === "switch-to-z") {
    return { pushedUpdate: pushedModel("fixture-model-z"), response: {} };
  }
  return { response: {} };
}
