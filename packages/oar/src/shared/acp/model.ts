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
 * - xai-grok-shell 1.0.12 (bc7f02e): `session/new|load` answer
 *   `models.currentModelId` (a requested model the account cannot use falls
 *   back to the default silently) and `session/set_model` answers
 *   `{_meta: {model}}` with the applied id.
 *
 * Null when the frame carries neither. Every such frame is an event
 * record with a `model` view, so `Session.model()` is the latest of them —
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
