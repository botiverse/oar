import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";

/*
 * claude's word on the model it will run (claude 2.1.284, probed 2026-09-30;
 * experiments/resume-overrides.ts):
 * - `--model <name>` applies on a new session and on `--resume` alike.
 * - `get_settings` answers `response.applied.model`, what will be sent to the
 *   API: an alias is resolved (`sonnet` → `claude-sonnet-5-5`, `default` →
 *   `claude-opus-5-5`, `sonnet[1m]` → `claude-sonnet-5-5[1m]`), a full ID or
 *   an unknown name is echoed as given (an unknown one then fails loudly at
 *   the provider on the first turn).
 * - A setting can replace the flag without a word: under an
 *   `availableModels: ["haiku"]` allowlist, `--model sonnet` runs
 *   `claude-opus-5-5`, stdout and stderr silent. Only the readback shows it.
 * - What an alias means today is the `list_models` row whose `value` is the
 *   alias: its `resolvedModel` (rows carry no `[1m]` style suffix, so the
 *   suffix is compared on its own).
 */

/** The `list_models` control request the adapter writes to stdin, under its own request id. */
export function claudeListModelsRequest(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "list_models" } })}\n`;
}

/** `claude-sonnet-5-5[1m]` → base `claude-sonnet-5-5`, suffix `[1m]`. */
function splitSuffix(model: string): { readonly base: string; readonly suffix: string } {
  const match = /^(.*?)(\[[^\]]*\])$/u.exec(model);
  return match === null ? { base: model, suffix: "" } : { base: match[1] ?? model, suffix: match[2] ?? "" };
}

/** What `alias` resolves to per a `list_models` answer, or null when the answer failed or lists no such alias. */
function resolvedAlias(alias: string, listAnswer: JsonRecord | Error): string | null {
  if (listAnswer instanceof Error) {
    return null;
  }
  const response = asRecord(listAnswer.response);
  if (response?.subtype !== "success") {
    return null;
  }
  const row = asRecordList(asRecord(response.response)?.models).find((model) => model.value === alias);
  return typeof row?.resolvedModel === "string" ? row.resolvedModel : null;
}

/**
 * Why claude will not run `requested`, read off its `get_settings` answer, or
 * null when `applied.model` is the requested model: the same name, or what
 * `list_models` says the requested alias resolves to, with the same suffix.
 */
export function claudeModelRefusal(requested: string, settingsAnswer: JsonRecord, listAnswer: JsonRecord | Error): string | null {
  const response = asRecord(settingsAnswer.response);
  if (response?.subtype !== "success") {
    const error = typeof response?.error === "string" ? response.error : "no success answer";
    return `claude could not report the model it runs (get_settings: ${error}), so model ${requested} cannot be confirmed`;
  }
  const applied = asRecord(asRecord(response.response)?.applied)?.model;
  if (typeof applied !== "string") {
    return `claude's get_settings answer names no applied model, so model ${requested} cannot be confirmed`;
  }
  if (applied === requested) {
    return null;
  }
  const want = splitSuffix(requested);
  const got = splitSuffix(applied);
  if (want.suffix === got.suffix && resolvedAlias(want.base, listAnswer) === got.base) {
    return null;
  }
  return `claude runs ${applied} although model ${requested} was requested`;
}
