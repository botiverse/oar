import { asNumber, asRecord, asRecordList, type JsonRecord } from "../json.js";

/**
 * The model an ACP agent reports as in effect, read from the agent's own
 * frames rather than from what we asked for. Two spellings exist upstream:
 *
 * - kimi-code (packages/acp-server, f9ca33376): `session/new|load|resume`
 *   answer `configOptions` with a `{type: "select", id: "model", currentValue}`
 *   row whose `currentValue` is the bare model id, and every switch
 *   (`session/set_model`, `set_config_option`) pushes
 *   `session/update {sessionUpdate: "config_option_update", configOptions}`
 *   BEFORE the switch request is answered; the `set_model` response is `{}`.
 * - xai-grok-shell 1.0.12 (bc7f02e): `session/new|load` answer
 *   `models.currentModelId` (a requested model the account cannot use falls
 *   back to the default silently) and `session/set_model` answers
 *   `{_meta: {model}}` with the applied id.
 *
 * Null when the frame carries neither. Every such frame is an event
 * record with a `model` event, so `Session.model()` is the latest of them;
 * the request parameter is never consulted.
 */
export function acpReportedModel(frame: JsonRecord | null): string | null {
  if (frame === null) {
    return null;
  }
  const option = asRecordList(frame.configOptions).find((entry) => entry.id === "model");
  if (typeof option?.currentValue === "string") {
    return option.currentValue;
  }
  const currentModelId = asRecord(frame.models)?.currentModelId;
  if (typeof currentModelId === "string") {
    return currentModelId;
  }
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const metaModel = asRecord(frame._meta)?.model;
  return typeof metaModel === "string" ? metaModel : null;
}

/**
 * The agent's reasoning-effort selector: the config option in ACP's reserved
 * `thought_level` category (ACP schema `SessionConfigOptionCategory`:
 * "thought/reasoning level"), read off a frame's `configOptions`. grok and
 * kimi put effort there, under their own ids ([env] 2026-09-29): grok
 * 1.0.41 `reasoning_effort` (xhigh/high/medium/low per model), kimi 2.0.0
 * `thinking` (low/high/max on k3); agy_acp_server 1.4.0 uses
 * `thinking_level` (low/medium/high on gemini-3.8-flash). The category, not the id, is what this shared
 * layer relies on; it carries no runtime identity. Null when the frame
 * advertises none.
 */
export function acpThoughtLevelOption(frame: JsonRecord | null): JsonRecord | null {
  if (frame === null) {
    return null;
  }
  return asRecordList(frame.configOptions).find((entry) => entry.category === "thought_level") ?? null;
}

/**
 * The reasoning effort an ACP agent reports as in effect: the `thought_level`
 * option's `currentValue` in a handshake answer (`session/new|resume|load`,
 * `session/set_config_option`, whose answer is "the full set of configuration
 * options and their current values") or a `config_option_update` push. Null
 * when the frame carries none; the request parameter is never consulted.
 */
export function acpReportedEffort(frame: JsonRecord | null): string | null {
  const current = acpThoughtLevelOption(frame)?.currentValue;
  return typeof current === "string" && current.length > 0 ? current : null;
}

/**
 * The context window a runtime advertises per model in its open answer, tracked
 * against the model in effect. Grok's `session/new` carries
 * `models.availableModels[]._meta.totalContextTokens` (the same table
 * `_x.ai/models/list` reports) while its prompt answer carries only the running
 * context count (`_meta.totalTokens`), so the window for the model in force is
 * the only place the missing half can come from.
 *
 * The model is whatever the runtime last reported, never what OAR requested: a
 * model whose advertised window was never read reports `null`, so a window can
 * never outlive the evidence for it. A frame that carries no model table claims
 * nothing and keeps the last one; one that carries a table replaces it whole.
 */
export interface AcpModelContextWindow {
  observe(frame: JsonRecord | null): void;
  window(): number | null;
}

export function createAcpModelContextWindow(): AcpModelContextWindow {
  let advertised = new Map<string, number>();
  let current: string | null = null;
  return {
    observe(frame) {
      if (frame === null) {
        return;
      }
      const table = advertisedWindows(frame);
      if (table !== undefined) {
        advertised = table;
      }
      const model = acpReportedModel(frame);
      if (model !== null) {
        current = model;
      }
    },
    window() {
      return current === null ? null : advertised.get(current) ?? null;
    },
  };
}

/**
 * The per-model windows a frame's model state advertises, in either envelope
 * spelling (`models.availableModels` on a session reply, a bare
 * `availableModels` on a catalog answer). `undefined` when the frame carries no
 * usable entry, which is not the same as an empty table.
 */
function advertisedWindows(frame: JsonRecord): Map<string, number> | undefined {
  const state = asRecord(frame.models) ?? frame;
  const windows = new Map<string, number>();
  for (const entry of asRecordList(state.availableModels ?? state.available_models)) {
    const id = entry.modelId ?? entry.model_id ?? entry.id;
    // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
    const window = asNumber(asRecord(entry._meta)?.totalContextTokens) ?? asNumber(entry.totalContextTokens) ?? asNumber(entry.contextWindow);
    if (typeof id === "string" && id.length > 0 && window !== null && window > 0) {
      windows.set(id, window);
    }
  }
  return windows.size === 0 ? undefined : windows;
}
