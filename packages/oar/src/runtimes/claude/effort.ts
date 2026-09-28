import { asRecord, type JsonRecord } from "../../shared/json.js";

/*
 * claude's word on the reasoning effort it will run (claude 2.1.284, probed
 * 2026-09-29; experiments/effort-channels.ts):
 * - `--effort <level>` reaches the Messages API as `output_config.effort`,
 *   on a new session and on `--resume` alike; without it claude sends its
 *   default (`medium`), also on a resume of a session that ran another level:
 *   claude keeps no effort per session.
 * - Nothing in the stream-json output names the effort: `system/init` carries
 *   only `per_turn_effort_active`, `result` none. An unknown level is dropped
 *   with a stderr warning ("Unknown --effort value 'x' — ignoring it and using
 *   the default effort"), a model without effort (haiku) sends none, and a
 *   `maxEffortLevel` setting or `CLAUDE_CODE_EFFORT_LEVEL` can clamp or
 *   override the flag, all silently on stdout.
 * - The one report is the `get_settings` control request, answered before any
 *   turn (token-free): `response.applied.effort` is "what will actually be
 *   sent to the API" after env overrides, session state and model defaults,
 *   `null` when the model takes none. The same answer also carries the merged
 *   settings of every source (`effective`, `sources`: hooks, permissions, any
 *   `env` block) verbatim, which is why the adapter consumes it instead of
 *   recording it (see session.ts).
 */

/** How long the adapter waits for claude to answer its `get_settings` read-back (after the SessionStart hooks). */
export const CLAUDE_EFFORT_READBACK_MS = 30_000;

/** The `get_settings` control request the adapter writes to stdin, under its own request id. */
export function claudeSettingsRequest(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_settings" } })}\n`;
}

/** The request id a `control_response` frame answers, or null for any other frame. */
export function claudeControlResponseId(message: JsonRecord): string | null {
  if (message.type !== "control_response") {
    return null;
  }
  const id = asRecord(message.response)?.request_id;
  return typeof id === "string" ? id : null;
}

/**
 * Why claude will not run `requested`, read off its `get_settings` answer, or
 * null when `applied.effort` is exactly the requested level. The message
 * names the requested level and what claude said instead.
 */
export function claudeEffortRefusal(requested: string, answer: JsonRecord): string | null {
  const response = asRecord(answer.response);
  if (response?.subtype !== "success") {
    const error = typeof response?.error === "string" ? response.error : "no success answer";
    return `claude could not report the effort it runs (get_settings: ${error}), so effort ${requested} cannot be confirmed`;
  }
  const applied = asRecord(asRecord(response.response)?.applied);
  if (applied === null || !("effort" in applied)) {
    return `claude's get_settings answer names no applied effort, so effort ${requested} cannot be confirmed`;
  }
  const model = typeof applied.model === "string" ? ` for ${applied.model}` : "";
  const effort = applied.effort;
  if (effort === requested) {
    return null;
  }
  if (effort === null) {
    return `claude sends no effort${model} (the model takes none), so effort ${requested} would be dropped`;
  }
  return `claude applies effort ${typeof effort === "string" ? effort : JSON.stringify(effort)}${model} although ${requested} was requested`;
}
