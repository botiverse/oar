import { asRecord, asRecordList, type JsonRecord } from "../json.js";

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
 * - xai-grok-shell: `session/new|load` answer `models.currentModelId` (1.0.44
 *   also a `configOptions` model row), and `session/set_model` answers the
 *   applied id in `_meta.model`: a bare string in 1.0.12 (bc7f02e), a Rust
 *   style `{Ok: id}` in 1.0.44 (probed 2026-09-30,
 *   experiments/resume-overrides.ts), pushing `config_option_update` only
 *   AFTER the answer. An unknown id is refused `-32602` ("unknown model id").
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
  if (typeof metaModel === "string") {
    return metaModel;
  }
  const applied = asRecord(metaModel)?.Ok;
  return typeof applied === "string" ? applied : null;
}

/** The models an agent pushes in `session/update` notifications, in order, for the open's model confirmation (effort.ts applyAcpModel). */
export function createAcpPushedModels(): { readonly observe: (update: unknown) => void; readonly list: () => readonly string[] } {
  const pushed: string[] = [];
  return {
    observe: (update) => {
      const model = acpReportedModel(asRecord(update));
      if (model !== null) {
        pushed.push(model);
      }
    },
    list: () => pushed,
  };
}

/**
 * The agent's reasoning-effort selector: the config option in ACP's reserved
 * `thought_level` category (ACP schema `SessionConfigOptionCategory`:
 * "thought/reasoning level"), read off a frame's `configOptions`. Both ACP
 * runtimes put effort there, under their own ids ([env] 2026-09-29): grok
 * 1.0.41 `reasoning_effort` (xhigh/high/medium/low per model), kimi 2.0.0
 * `thinking` (low/high/max on k3). The category, not the id, is what this
 * shared layer relies on; it carries no runtime identity. Null when the frame
 * advertises none.
 *
 * cursor-agent 2026.09.28 lists two for most Claude models: `thinking`
 * (false/true) and `effort` (low…max). The level menu wins over the on/off
 * switch; a model whose only option is the switch (claude-haiku-4-5) keeps it.
 */
export function acpThoughtLevelOption(frame: JsonRecord | null): JsonRecord | null {
  if (frame === null) {
    return null;
  }
  const candidates = asRecordList(frame.configOptions).filter((entry) => entry.category === "thought_level");
  return candidates.find((entry) => !isOnOffSwitch(entry)) ?? candidates[0] ?? null;
}

function isOnOffSwitch(option: JsonRecord): boolean {
  const values = asRecordList(option.options).map((entry) => entry.value);
  return values.length === 2 && values.includes("false") && values.includes("true");
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
