/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone untyped fixture module for fake-acp-agent.mjs. */
// The model the fixture "really" runs, regardless of what was requested: the
// silent-fallback shape both real agents have (grok falls back to the default
// when the requested model is not allowed; kimi keeps its own current id).
// Reported in both upstream spellings: kimi's configOptions row and grok's
// models.currentModelId.
const EFFECTIVE_MODEL = "fixture-model-x";
// Only a `set_config_option` model switch (cursor) moves it; `set_model` never does.
let currentModel = EFFECTIVE_MODEL;

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

// The fixture's reasoning-effort selector, in ACP's `thought_level` category
// under an id of its own (grok says `reasoning_effort`, kimi `thinking`): the
// category is what oar looks for, never the id.
const EFFORT_ID = "fixture_effort";
const EFFORT_LEVELS = ["low", "medium", "high"];

function effortOption(currentValue) {
  return {
    type: "select",
    id: EFFORT_ID,
    name: "Effort",
    category: "thought_level",
    currentValue,
    options: EFFORT_LEVELS.map((value) => ({ value, name: value })),
  };
}

/** `mode` "no-thought-level": an agent that offers no effort selector at all. */
export function modelReport(mode) {
  return {
    configOptions: [modelOption(EFFECTIVE_MODEL), ...(mode === "no-thought-level" ? [] : [effortOption("medium")])],
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
// Mode "cursor" replays cursor-agent 2026.09.28: the effort selector exists
// only when the client opts into `clientCapabilities._meta.parameterizedModelPicker`.
// Mode "antigravity" replays agy_acp_server 1.2.1, whose effort is part of the model id.
export function sessionModelReport(mode, parameterizedModelPicker) {
  const noEffort = mode === "antigravity" || (mode === "cursor" && parameterizedModelPicker !== true);
  return modelReport(noEffort ? "no-thought-level" : mode);
}

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

/**
 * What `session/set_config_option {configId: "model", value}` does, the way
 * cursor-agent 2026.09.28 answers it: a known model is applied and answered
 * with the full option set, the new model's effort menu at its default; no
 * `config_option_update` is pushed. An unknown model is refused `-32602`.
 */
function setModelOption(value, effort) {
  if (value !== EFFECTIVE_MODEL && value !== "requested-y") {
    return { error: { code: -32_602, message: "Invalid params", data: `unknown model ${String(value)}` } };
  }
  currentModel = value;
  return { response: { configOptions: [modelOption(value), ...(effort === true ? [effortOption("medium")] : [])] } };
}

/**
 * What `session/set_config_option {configId, value}` does to the effort
 * selector, the way grok 1.0.41 / kimi 2.0.0 answer: a known level is applied,
 * pushed as a `config_option_update` (kimi pushes before answering) and
 * answered with every option's current value; an unknown one is refused
 * `-32602 Invalid params`. `sticky` is a level the fixture accepts but does
 * not apply (answered at `medium`), the silent substitution oar must refuse.
 */
export function setConfigOption(params, effort = true) {
  if (params?.configId === "model") {
    return setModelOption(params.value, effort);
  }
  if (params?.configId !== EFFORT_ID) {
    return { error: { code: -32_602, message: "Invalid params", data: `unknown config option ${String(params?.configId)}` } };
  }
  if (params.value === "sticky") {
    return { response: { configOptions: [modelOption(currentModel), effortOption("medium")] } };
  }
  if (!EFFORT_LEVELS.includes(params.value)) {
    return { error: { code: -32_602, message: "Invalid params", data: `unknown ${EFFORT_ID} value` } };
  }
  const configOptions = [modelOption(currentModel), effortOption(params.value)];
  return { pushedUpdate: { sessionUpdate: "config_option_update", configOptions }, response: { configOptions } };
}

/**
 * Answer `session/set_model` or `session/set_config_option` on the wire:
 * any push first (kimi pushes before it answers), then the answer, or the
 * refusal as a JSON-RPC error. `effort` false: the agent has no effort
 * selector (agy_acp_server 1.2.1), so a model switch answers the model alone.
 */
export function answerConfigRequest(message, wire, effort = true) {
  const outcome = message.method === "session/set_model"
    ? setModelResponse(message.params?.modelId)
    : setConfigOption(message.params, effort);
  if (outcome.error !== undefined) {
    wire.error(message.id, outcome.error.code, outcome.error.message, outcome.error.data);
    return;
  }
  if (outcome.pushedUpdate !== undefined) {
    wire.update(outcome.pushedUpdate);
  }
  wire.result(message.id, outcome.response);
}
